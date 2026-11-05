import Foundation

// `scan --cached-only`: what the cache already knows about each clip, and nothing else. A clip is looked up by its path, size
// and modification time, which costs a stat or two, and is never opened. Nothing is decoded, analysed or written, and the
// cache's lock isn't taken, so this answers at once even while a scan is writing the same cache. For bringing back a
// project's last results when the panel opens.

/// Lines are gathered and written 512 at a time, so 20,000 clips cost about a hundred writes rather than 60,000.
private final class Batch {
    private var lines: [String] = []
    private let output: Output
    init(_ output: Output) { self.output = output }
    func add(_ line: String) {
        lines.append(line)
        if lines.count >= 512 { flush() }
    }
    func flush() {
        guard !lines.isEmpty else { return }
        output.emit(lines.joined(separator: "\n"))
        lines.removeAll(keepingCapacity: true)
    }
}

/// The clip's cached Tier 1 fields, with the thumbnail set to null when its file has gone.
private func withThumbChecked(_ fields: String, thumb: String?, gone: Bool) -> String {
    guard let thumb, gone else { return fields }
    return fields.replacingOccurrences(of: "\"thumb\":" + jsonString(thumb), with: "\"thumb\":null")
}

func scanCachedOnly(_ o: Options, paths: [String]) {
    let start = now()
    let output = Output()
    let count = paths.count
    output.emit("{\"type\":\"start\",\"total\":\(count),\"schema\":\(schemaVersion),\"engineVersion\":\"\(engineVersion)\",\"cachedOnly\":true}")
    let cache = ResultCache(dir: o.cacheDir, readOnly: true)
    let loaded = now()
    let jsonPaths = paths.map(jsonString)

    // File details for every clip, in parallel: on a drive whose details aren't in memory yet, a stat waits on the disk.
    var keys = [FileKey?](repeating: nil, count: count)
    var missing = [String?](repeating: nil, count: count)
    keys.withUnsafeMutableBufferPointer { k in
        missing.withUnsafeMutableBufferPointer { m in
            DispatchQueue.concurrentPerform(iterations: (count + 63) / 64) { block in
                for i in (block * 64)..<min(count, block * 64 + 64) {
                    if let key = FileKey.of(paths[i]) { k[i] = key } else { m[i] = String(cString: strerror(errno)) }
                }
            }
        }
    }

    let statted = now()
    let batch = Batch(output)
    var entries = [CacheEntry?](repeating: nil, count: count)
    var failed = 0, uncached = 0, degraded = 0, complete = 0, withTier0 = 0
    var settled = [Bool](repeating: false, count: count)     // failed or reported as not in the cache

    /// A clip the cache can't answer from this tier on. `changed` says the cache knew an older version of the file.
    func notCached(_ i: Int, tier: Int, changed: Bool = false) {
        settled[i] = true
        uncached += 1
        batch.add("{\"type\":\"uncached\",\"path\":\(jsonPaths[i]),\"tier\":\(tier),\"changed\":\(changed)}")
    }

    for i in 0..<count {
        guard let key = keys[i] else {
            var f = Fields()
            f.add("message", missing[i] ?? "unknown error")
            batch.add("{\"type\":\"error\",\"path\":\(jsonPaths[i]),\(f.joined)}")
            failed += 1
            settled[i] = true
            continue
        }
        guard let e = cache.lookup(jsonPaths[i], key: key) else {
            notCached(i, tier: 0, changed: cache.knowsOtherVersion(jsonPaths[i]))
            continue
        }
        entries[i] = e
        if let err = e.error {
            batch.add("{\"type\":\"error\",\"path\":\(jsonPaths[i]),\(err)}")
            failed += 1
            settled[i] = true
        } else if let fields = e.tier0 {
            withTier0 += 1
            batch.add(clipLine(tier: 0, path: jsonPaths[i], cached: true, ms: 0, fields: fields))
        } else {
            notCached(i, tier: 0)
        }
    }
    if o.tier >= 1 {
        // Whether each thumbnail is still there, checked in parallel: a check costs about as much as a stat.
        var gone = [Bool](repeating: false, count: count)
        entries.withUnsafeBufferPointer { e in
            gone.withUnsafeMutableBufferPointer { g in
                DispatchQueue.concurrentPerform(iterations: (count + 63) / 64) { block in
                    for i in (block * 64)..<min(count, block * 64 + 64) {
                        if let t = e[i]?.thumb, access(t, R_OK) != 0 { g[i] = true }
                    }
                }
            }
        }
        for i in 0..<count where !settled[i] {
            guard let e = entries[i], let fields = e.tier1 else {
                notCached(i, tier: 1)
                continue
            }
            if e.noPicture { degraded += 1 }
            batch.add(clipLine(tier: 1, path: jsonPaths[i], cached: true, ms: 0, fields: withThumbChecked(fields, thumb: e.thumb, gone: gone[i])))
        }
    }
    var sources = [PrintSource?](repeating: nil, count: o.tier == 2 ? count : 0)
    if o.tier == 2 {
        for i in 0..<count where !settled[i] {
            // As in a scan, a result counts only with its print, from the revision this Mac makes.
            guard let e = entries[i], let key = keys[i], let fields = e.tier2,
                  let stored = cache.storedPrint(jsonPaths[i], key: key), stored.revision == currentPrintRevision else {
                notCached(i, tier: 2)
                continue
            }
            batch.add(clipLine(tier: 2, path: jsonPaths[i], cached: true, ms: 0, fields: fields))
            sources[i] = .stored(stored)
        }
    }
    for i in 0..<count where !settled[i] { complete += 1 }
    batch.flush()
    let answered = now()
    if o.tier == 2 {
        let groups = similarGroups(sources: sources, folders: paths.map { ($0 as NSString).deletingLastPathComponent },
                                   sortKey: paths, revision: currentPrintRevision, load: cache.readPrint)
        let json = groups.enumerated().map { n, members in
            "{\"id\":\(n + 1),\"paths\":[" + members.map { jsonPaths[$0] }.joined(separator: ",") + "]}"
        }
        output.emit("{\"type\":\"groups\",\"groups\":[" + json.joined(separator: ",") + "]}")
    }
    let wall = Int(now() - start)
    output.emit("{\"type\":\"done\",\"clips\":\(withTier0),\"failed\":\(failed),\"cached\":\(complete),\"wallMs\":\(wall),\"degraded\":\(degraded),\"uncached\":\(uncached)}")
    log("cached only: \(complete) answered, \(uncached) not in the cache, \(failed) failed, wall \(wall) ms. "
        + String(format: "Index read in %.0f ms, files checked by %.0f, answered by %.0f", loaded - start, statted - start, answered - start))
}
