import Foundation

let schemaVersion = 3

struct CacheEntry {
    var size: Int64
    var mtime: Double
    var tier0: String?
    var tier1: String?
    var tier2: String?
    var error: String?
    var thumb: String?
    /// A Tier 1 result with no picture data and a reason, which has no thumbnail to wait for.
    var noPicture = false
    /// When a scan last used this entry, in seconds since 1970. 0 for never recorded, which is oldest.
    var used: Double = 0
}

/// Where one clip's feature prints sit in the prints file. Only this is kept in memory; the floats are read when grouping
/// needs them, so memory doesn't grow with the size of a project.
struct PrintRef {
    let offset: Int64
    let moments: Int
    let dim: Int
    let revision: Int
    let a: Float
    let b: Float
}

/// Append-only index, one line per result, local to the machine. The newest line for a path wins,
/// and the file is rewritten on open once stale lines dominate. Key: path, size, mtime, schema.
final class ResultCache {
    let dir: String
    private var entries: [String: CacheEntry] = [:]
    private var fd: Int32 = -1
    private let lock = NSLock()
    private var indexPath: String { dir + "/index-v\(schemaVersion).tsv" }
    var thumbDir: String { dir + "/thumbs" }

    init(dir: String) {
        self.dir = dir
        try? FileManager.default.createDirectory(atPath: thumbDir, withIntermediateDirectories: true)
        load()
        fd = open(indexPath, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0o644)
        if fd < 0 { log("cache: cannot open \(indexPath): \(String(cString: strerror(errno)))") }
    }

    private func key(_ s: Int64, _ m: Double) -> String { "\(s)\t\(String(format: "%.6f", m))" }

    private func load() {
        guard let data = FileManager.default.contents(atPath: indexPath) else { return }
        var lines = 0
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            // The last line may be torn by a full disk or a crash, so it only counts if it was finished.
            var finished = raw.split(separator: 10, omittingEmptySubsequences: true)
            if raw.last != 10, !finished.isEmpty { finished.removeLast() }
            for lineBytes in finished {
                lines += 1
                let parts = lineBytes.split(separator: 9, maxSplits: 4, omittingEmptySubsequences: false)
                guard parts.count == 5 else { continue }
                let kind = String(decoding: parts[0], as: UTF8.self)
                guard let size = Int64(String(decoding: parts[1], as: UTF8.self)),
                      let mtime = Double(String(decoding: parts[2], as: UTF8.self)) else { continue }
                let path = String(decoding: parts[3], as: UTF8.self)
                var e = entries[path] ?? CacheEntry(size: size, mtime: mtime)
                if e.size != size || e.mtime != mtime { e = CacheEntry(size: size, mtime: mtime) }
                let value = String(decoding: parts[4], as: UTF8.self)
                // A torn write can also run into the next line. Output is only ever whole JSON, so check it.
                guard let whole = "{\(value)}".data(using: .utf8),
                      (try? JSONSerialization.jsonObject(with: whole)) != nil else { continue }
                switch kind {
                case "0": e.tier0 = value
                case "1":
                    e.tier1 = value
                    e.thumb = nil
                    e.noPicture = value.contains("\"reason\":\"")
                    if let r = value.range(of: "\"thumb\":\""), let end = value[r.upperBound...].firstIndex(of: "\"") {
                        e.thumb = String(value[r.upperBound..<end])
                    }
                case "2": e.tier2 = value
                case "e": e.error = value
                case "u":
                    if let r = value.range(of: "\"t\":"), let t = Double(value[r.upperBound...]) { e.used = t }
                default: break
                }
                entries[path] = e
            }
        }
        if lines > entries.count * 3 + 64 { compact() }
    }

    private func compact() {
        var out = ""
        for (path, e) in entries {
            let k = key(e.size, e.mtime)
            if let v = e.tier0 { out += "0\t\(k)\t\(path)\t\(v)\n" }
            if let v = e.tier1 { out += "1\t\(k)\t\(path)\t\(v)\n" }
            if let v = e.tier2 { out += "2\t\(k)\t\(path)\t\(v)\n" }
            if let v = e.error { out += "e\t\(k)\t\(path)\t\(v)\n" }
            if e.used > 0 { out += "u\t\(k)\t\(path)\t\"t\":\(Int(e.used))\n" }
        }
        FileManager.default.createFile(atPath: indexPath + ".tmp", contents: Data(out.utf8))
        rename(indexPath + ".tmp", indexPath)
    }

    func lookup(_ jsonPath: String, size: Int64, mtime: Double) -> CacheEntry? {
        lock.lock()
        defer { lock.unlock() }
        // The stored mtime keeps six decimals, so compare within that precision.
        guard let e = entries[jsonPath], e.size == size, abs(e.mtime - mtime) < 2e-6 else { return nil }
        touched.insert(jsonPath)
        return e
    }

    func store(kind: String, jsonPath: String, size: Int64, mtime: Double, value: String) {
        if kind != "u" { remember(kind: kind, jsonPath: jsonPath, size: size, mtime: mtime, value: value) }
        guard fd >= 0 else { return }
        let line = "\(kind)\t\(key(size, mtime))\t\(jsonPath)\t\(value)\n"
        _ = line.withCString { write(fd, $0, strlen($0)) }
    }

    /// Feature prints live beside the index in one binary file, because they're long and the panel never sees them.
    /// A record: magic, key hash, moments, floats per moment, revision, mean colour, then the floats. The newest for a key wins.
    private var printsPath: String { dir + "/prints-v\(schemaVersion).bin" }
    private var printIndex: [UInt64: PrintRef] = [:]
    private var printRecords = 0
    private var printsEnd: Int64 = 0
    private var printsLoaded = false
    private var printsFD: Int32 = -1
    private static let printMagic: UInt32 = 0x5052_4e54
    private static let printHeader = 32

    private func printKey(_ jsonPath: String, _ size: Int64, _ mtime: Double) -> UInt64 {
        var h: UInt64 = 0xcbf2_9ce4_8423_2325
        for b in "\(jsonPath)|\(size)|\(String(format: "%.6f", mtime))".utf8 { h = (h ^ UInt64(b)) &* 0x0000_0100_0000_01b3 }
        return h
    }

    /// Reads only the record headers, skipping the floats, so opening a big cache costs little. A torn or foreign record ends
    /// the read and the file is cut there, so new records stay readable.
    private func loadPrints() {
        printsLoaded = true
        printsFD = open(printsPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        guard printsFD >= 0 else { return }
        var st = stat()
        guard fstat(printsFD, &st) == 0 else { return }
        let size = Int64(st.st_size)
        var pos: Int64 = 0
        var header = [UInt8](repeating: 0, count: ResultCache.printHeader)
        while pos + Int64(ResultCache.printHeader) <= size {
            guard pread(printsFD, &header, header.count, pos) == header.count else { break }
            let ref: PrintRef? = header.withUnsafeBufferPointer { h in
                let b = Bytes(base: h.baseAddress!, count: h.count)
                guard b.u32(0) == ResultCache.printMagic else { return nil }
                let moments = Int(b.u32(12)), dim = Int(b.u32(16))
                guard moments >= 1, moments <= 3, dim >= 1, dim <= 4096 else { return nil }
                return PrintRef(offset: pos, moments: moments, dim: dim, revision: Int(b.u32(20)),
                                a: Float(bitPattern: b.u32(24)), b: Float(bitPattern: b.u32(28)))
            }
            guard let ref else { break }
            let end = pos + Int64(ResultCache.printHeader + ref.moments * ref.dim * 4)
            guard end <= size else { break }
            printIndex[header.withUnsafeBufferPointer { Bytes(base: $0.baseAddress!, count: $0.count).u64(4) }] = ref
            printRecords += 1
            pos = end
        }
        if pos < size { _ = ftruncate(printsFD, off_t(pos)) }
        printsEnd = pos
    }

    func storedPrint(_ jsonPath: String, size: Int64, mtime: Double) -> PrintRef? {
        lock.lock()
        defer { lock.unlock() }
        if !printsLoaded { loadPrints() }
        return printIndex[printKey(jsonPath, size, mtime)]
    }

    /// The floats behind a reference. Safe from any thread.
    func readPrint(_ ref: PrintRef) -> ClipPrint? {
        let count = ref.moments * ref.dim
        var values = [Float](repeating: 0, count: count)
        let want = count * 4
        let got = values.withUnsafeMutableBytes { pread(printsFD, $0.baseAddress, want, ref.offset + Int64(ResultCache.printHeader)) }
        guard got == want else { return nil }
        return ClipPrint(values: values, count: ref.moments, revision: ref.revision, a: ref.a, b: ref.b)
    }

    private func record(_ p: ClipPrint, key: UInt64) -> Data {
        var record = Data()
        func put32(_ v: UInt32) { withUnsafeBytes(of: v.bigEndian) { record.append(contentsOf: $0) } }
        put32(ResultCache.printMagic)
        withUnsafeBytes(of: key.bigEndian) { record.append(contentsOf: $0) }
        put32(UInt32(p.count))
        put32(UInt32(p.values.count / p.count))
        put32(UInt32(p.revision))
        put32(p.a.bitPattern)
        put32(p.b.bitPattern)
        p.values.withUnsafeBytes { record.append(contentsOf: $0) }
        return record
    }

    /// Appends a clip's prints and returns where they went, or nil when the cache can't be written.
    func storePrint(_ p: ClipPrint, jsonPath: String, size: Int64, mtime: Double) -> PrintRef? {
        guard p.count >= 1, p.count <= 3, p.values.count % p.count == 0 else { return nil }
        let key = printKey(jsonPath, size, mtime)
        let data = record(p, key: key)
        lock.lock()
        defer { lock.unlock() }
        if !printsLoaded { loadPrints() }
        guard printsFD >= 0 else { return nil }
        let at = printsEnd
        let wrote = data.withUnsafeBytes { pwrite(printsFD, $0.baseAddress, $0.count, at) }
        guard wrote == data.count else { return nil }
        printsEnd += Int64(data.count)
        printRecords += 1
        let ref = PrintRef(offset: at, moments: p.count, dim: p.values.count / p.count, revision: p.revision, a: p.a, b: p.b)
        printIndex[key] = ref
        return ref
    }

    // MARK: Upkeep

    private var touched = Set<String>()

    /// Marks an entry as used by this scan, so it's the last to go when the cache is full.
    func touch(_ jsonPath: String) {
        lock.lock()
        touched.insert(jsonPath)
        lock.unlock()
    }

    /// Run at the end of a scan, after grouping has read its prints. Records what was used, drops oldest entries while the cache is
    /// over `limit` bytes, deletes thumbnails nothing points to, and rewrites the prints file once dead records dominate. Entries
    /// used by this scan are never dropped.
    func maintain(limit: Int64) {
        lock.lock()
        defer { lock.unlock() }
        if !printsLoaded { loadPrints() }
        let stamp = Date().timeIntervalSince1970
        var changed = false
        for path in touched {
            guard var e = entries[path] else { continue }
            if stamp - e.used > 6 * 3600 {
                e.used = stamp
                entries[path] = e
                store(kind: "u", jsonPath: path, size: e.size, mtime: e.mtime, value: "\"t\":\(Int(stamp))")
            }
        }

        // Thumbnails on disk, with their sizes.
        var thumbs: [String: Int64] = [:]
        if let names = try? FileManager.default.contentsOfDirectory(atPath: thumbDir) {
            for name in names where name.hasSuffix(".jpg") {
                var st = stat()
                if stat(thumbDir + "/" + name, &st) == 0 { thumbs[thumbDir + "/" + name] = Int64(st.st_size) }
            }
        }
        func indexBytes() -> Int64 {
            var st = stat()
            return stat(indexPath, &st) == 0 ? Int64(st.st_size) : 0
        }
        func printBytes(_ e: CacheEntry, _ path: String) -> Int64 {
            guard let r = printIndex[printKey(path, e.size, e.mtime)] else { return 0 }
            return Int64(ResultCache.printHeader + r.moments * r.dim * 4)
        }
        var total = indexBytes() + printsEnd + thumbs.values.reduce(0, +)
        if total > limit {
            let target = limit * 8 / 10
            for (path, e) in entries.sorted(by: { $0.value.used < $1.value.used }) where total > target && !touched.contains(path) {
                if let t = e.thumb, let bytes = thumbs[t] {
                    unlink(t)
                    thumbs[t] = nil
                    total -= bytes
                }
                total -= printBytes(e, path) + Int64(path.utf8.count + (e.tier0?.utf8.count ?? 0) + (e.tier1?.utf8.count ?? 0) + (e.tier2?.utf8.count ?? 0) + 120)
                entries[path] = nil
                changed = true
                trace.route("cache-evicted")
            }
        }
        // A thumbnail nothing points to is left over from a file that changed or an entry that went.
        let wanted = Set(entries.values.compactMap(\.thumb))
        for t in thumbs.keys where !wanted.contains(t) {
            unlink(t)
            trace.route("thumb-pruned")
        }
        if changed { compact() }

        // Prints: keep the newest record of every entry that still has a Tier 2 result.
        let live = Set(entries.compactMap { path, e in e.tier2 == nil ? nil : printKey(path, e.size, e.mtime) })
        let liveRecords = printIndex.keys.filter(live.contains).count
        if printRecords > liveRecords * 3 / 2 + 16 || (changed && printRecords > liveRecords) { compactPrints(live) }
    }

    private func compactPrints(_ live: Set<UInt64>) {
        let tmp = printsPath + ".tmp"
        let fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o644)
        guard fd >= 0 else { return }
        var newIndex: [UInt64: PrintRef] = [:]
        var at: Int64 = 0
        for (key, ref) in printIndex.sorted(by: { $0.value.offset < $1.value.offset }) where live.contains(key) {
            let bytes = ResultCache.printHeader + ref.moments * ref.dim * 4
            var buffer = [UInt8](repeating: 0, count: bytes)
            guard pread(printsFD, &buffer, bytes, ref.offset) == bytes, write(fd, buffer, bytes) == bytes else {
                close(fd)
                unlink(tmp)
                return
            }
            newIndex[key] = PrintRef(offset: at, moments: ref.moments, dim: ref.dim, revision: ref.revision, a: ref.a, b: ref.b)
            at += Int64(bytes)
        }
        close(fd)
        guard rename(tmp, printsPath) == 0 else { return }
        close(printsFD)
        printsFD = open(printsPath, O_RDWR | O_CLOEXEC)
        printIndex = newIndex
        printRecords = newIndex.count
        printsEnd = at
        trace.route("prints-compacted")
    }

    /// Keeps the in-memory index in step with what was written, so upkeep at the end of the scan sees it.
    private func remember(kind: String, jsonPath: String, size: Int64, mtime: Double, value: String) {
        lock.lock()                     // never called with the lock held: upkeep writes only "u", which skips this
        defer { lock.unlock() }
        var e = entries[jsonPath] ?? CacheEntry(size: size, mtime: mtime)
        if e.size != size || abs(e.mtime - mtime) >= 2e-6 { e = CacheEntry(size: size, mtime: mtime) }
        switch kind {
        case "0": e.tier0 = value
        case "1":
            e.tier1 = value
            e.noPicture = value.contains("\"reason\":\"")
            e.thumb = nil
            if let r = value.range(of: "\"thumb\":\""), let end = value[r.upperBound...].firstIndex(of: "\"") {
                e.thumb = String(value[r.upperBound..<end])
            }
        case "2": e.tier2 = value
        case "e": e.error = value
        default: break
        }
        entries[jsonPath] = e
        touched.insert(jsonPath)
    }

    func thumbPath(path: String, size: Int64, mtime: Double) -> String {
        var h: UInt64 = 0xcbf2_9ce4_8423_2325
        for b in "\(path)|\(size)|\(mtime)|\(schemaVersion)".utf8 {
            h = (h ^ UInt64(b)) &* 0x0000_0100_0000_01b3
        }
        return thumbDir + "/" + String(format: "%016llx.jpg", h)
    }
}
