import Foundation

let schemaVersion = 1

struct CacheEntry {
    var size: Int64
    var mtime: Double
    var tier0: String?
    var tier1: String?
    var error: String?
    var thumb: String?
    /// A Tier 1 result with no picture data and a reason, which has no thumbnail to wait for.
    var noPicture = false
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
                case "e": e.error = value
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
            if let v = e.error { out += "e\t\(k)\t\(path)\t\(v)\n" }
        }
        FileManager.default.createFile(atPath: indexPath + ".tmp", contents: Data(out.utf8))
        rename(indexPath + ".tmp", indexPath)
    }

    func lookup(_ jsonPath: String, size: Int64, mtime: Double) -> CacheEntry? {
        lock.lock()
        defer { lock.unlock() }
        // The stored mtime keeps six decimals, so compare within that precision.
        guard let e = entries[jsonPath], e.size == size, abs(e.mtime - mtime) < 2e-6 else { return nil }
        return e
    }

    func store(kind: String, jsonPath: String, size: Int64, mtime: Double, value: String) {
        guard fd >= 0 else { return }
        let line = "\(kind)\t\(key(size, mtime))\t\(jsonPath)\t\(value)\n"
        _ = line.withCString { write(fd, $0, strlen($0)) }
    }

    func thumbPath(path: String, size: Int64, mtime: Double) -> String {
        var h: UInt64 = 0xcbf2_9ce4_8423_2325
        for b in "\(path)|\(size)|\(mtime)|\(schemaVersion)".utf8 {
            h = (h ^ UInt64(b)) &* 0x0000_0100_0000_01b3
        }
        return thumbDir + "/" + String(format: "%016llx.jpg", h)
    }
}
