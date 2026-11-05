import Foundation

// Direct MP4/MOV structure reader. It touches only top-level box headers and `moov`,
// so a clip costs one to three small reads however large the media is.

@inline(__always) func fourCC(_ s: StaticString) -> UInt32 {
    let p = s.utf8Start
    return UInt32(p[0]) << 24 | UInt32(p[1]) << 16 | UInt32(p[2]) << 8 | UInt32(p[3])
}

func fourCCString(_ v: UInt32) -> String {
    let b = [UInt8(v >> 24), UInt8((v >> 16) & 255), UInt8((v >> 8) & 255), UInt8(v & 255)]
    return String(decoding: b, as: UTF8.self)
}

/// Bounds-checked big-endian view over a byte range. Every malformed read returns 0,
/// and `valid` guards the callers, so a corrupt table can never crash a scan.
struct Bytes {
    let base: UnsafePointer<UInt8>
    let count: Int

    @inline(__always) func valid(_ off: Int, _ n: Int) -> Bool { off >= 0 && n >= 0 && off <= count - n }
    @inline(__always) func u8(_ o: Int) -> UInt8 { valid(o, 1) ? base[o] : 0 }
    @inline(__always) func u16(_ o: Int) -> UInt16 {
        valid(o, 2) ? UInt16(base[o]) << 8 | UInt16(base[o + 1]) : 0
    }
    @inline(__always) func u32(_ o: Int) -> UInt32 {
        guard valid(o, 4) else { return 0 }
        return UInt32(bigEndian: UnsafeRawPointer(base + o).loadUnaligned(as: UInt32.self))
    }
    @inline(__always) func i32(_ o: Int) -> Int32 { Int32(bitPattern: u32(o)) }
    @inline(__always) func u64(_ o: Int) -> UInt64 {
        guard valid(o, 8) else { return 0 }
        return UInt64(bigEndian: UnsafeRawPointer(base + o).loadUnaligned(as: UInt64.self))
    }
    func sub(_ o: Int, _ n: Int) -> Bytes {
        guard valid(o, n) else { return Bytes(base: base, count: 0) }
        return Bytes(base: base + o, count: n)
    }
    func string(_ o: Int, _ n: Int) -> String? {
        guard valid(o, n), n > 0 else { return nil }
        let raw = UnsafeBufferPointer(start: base + o, count: n)
        let end = raw.firstIndex(of: 0) ?? n
        return String(decoding: UnsafeBufferPointer(start: base + o, count: end), as: UTF8.self)
    }
    var data: Data { Data(bytes: base, count: count) }
}

struct Box {
    let type: UInt32
    let body: Bytes
}

/// Iterates child boxes of a container body.
struct BoxIterator: Sequence, IteratorProtocol {
    let buf: Bytes
    var pos = 0
    init(_ b: Bytes) { buf = b }
    mutating func next() -> Box? {
        guard buf.valid(pos, 8) else { return nil }
        var size = Int(buf.u32(pos))
        let type = buf.u32(pos + 4)
        var header = 8
        if size == 1 {
            guard buf.valid(pos, 16) else { return nil }
            let big = buf.u64(pos + 8)
            guard big < UInt64(Int.max) else { return nil }
            size = Int(big)
            header = 16
        } else if size == 0 {
            size = buf.count - pos
        }
        guard size >= header, buf.valid(pos, size) else { return nil }
        let box = Box(type: type, body: buf.sub(pos + header, size - header))
        pos += size
        return box
    }
}

final class Track {
    var handler: UInt32 = 0
    var timescale: UInt32 = 0
    var mdhdDuration: UInt64 = 0
    var tkhdWidth = 0.0
    var tkhdHeight = 0.0
    var matrix: (Int32, Int32, Int32, Int32) = (0x10000, 0, 0, 0x10000)
    var format: UInt32 = 0
    var stsdEntry = Bytes(base: UnsafePointer(bitPattern: 1)!, count: 0)
    var stts = Bytes(base: UnsafePointer(bitPattern: 1)!, count: 0)
    var stsc = Bytes(base: UnsafePointer(bitPattern: 1)!, count: 0)
    var stss: Bytes?
    var stszFixed: UInt32 = 0
    var sampleCount = 0
    var sizes = Bytes(base: UnsafePointer(bitPattern: 1)!, count: 0)
    var chunkOffsets = Bytes(base: UnsafePointer(bitPattern: 1)!, count: 0)
    var chunkOffsetWide = false

    var chunkCount: Int { chunkOffsetWide ? chunkOffsets.count / 8 : chunkOffsets.count / 4 }
    var syncCount: Int { stss.map { $0.count / 4 } ?? 0 }

    @inline(__always) func sampleSize(_ i: Int) -> Int {
        stszFixed != 0 ? Int(stszFixed) : Int(sizes.u32(i * 4))
    }
    @inline(__always) func chunkOffset(_ c: Int) -> Int64 {
        chunkOffsetWide ? Int64(truncatingIfNeeded: chunkOffsets.u64(c * 8)) : Int64(chunkOffsets.u32(c * 4))
    }

    /// File offset of a sample. Walks stsc once, so it costs O(chunk runs + samples in chunk).
    func sampleOffset(_ sample: Int) -> Int64? {
        guard let loc = locate(sample) else { return nil }
        var off = chunkOffset(loc.chunk)
        if stszFixed != 0 {
            off += Int64(loc.indexInChunk) * Int64(stszFixed)
        } else {
            let first = sample - loc.indexInChunk
            for s in first..<sample { off += Int64(sizes.u32(s * 4)) }
        }
        return off
    }

    func locate(_ sample: Int) -> (chunk: Int, indexInChunk: Int, samplesInChunk: Int)? {
        guard sample >= 0, sample < sampleCount else { return nil }
        let runs = stsc.count / 12
        guard runs > 0, chunkCount > 0 else { return nil }
        var firstSampleOfRun = 0
        for r in 0..<runs {
            let first = Int(stsc.u32(r * 12)) - 1
            let perChunk = Int(stsc.u32(r * 12 + 4))
            guard perChunk > 0, first >= 0 else { return nil }
            let nextFirst = r + 1 < runs ? Int(stsc.u32((r + 1) * 12)) - 1 : chunkCount
            let span = nextFirst - first
            guard span >= 0 else { return nil }
            let samplesInRun = span &* perChunk
            if sample < firstSampleOfRun + samplesInRun {
                let rel = sample - firstSampleOfRun
                let chunk = first + rel / perChunk
                guard chunk < chunkCount else { return nil }
                return (chunk, rel % perChunk, perChunk)
            }
            firstSampleOfRun += samplesInRun
        }
        return nil
    }

    /// Media duration from stts, which is correct even when mdhd is zero.
    func sttsTotal() -> UInt64 {
        var t: UInt64 = 0
        for i in 0..<(stts.count / 8) { t &+= UInt64(stts.u32(i * 8)) &* UInt64(stts.u32(i * 8 + 4)) }
        return t
    }

    /// Sample index at a media time.
    func sampleAt(mediaTime: UInt64) -> Int {
        var t: UInt64 = 0
        var s = 0
        for i in 0..<(stts.count / 8) {
            let n = UInt64(stts.u32(i * 8)), d = UInt64(stts.u32(i * 8 + 4))
            if d > 0, t + n &* d > mediaTime { return s + Int((mediaTime - t) / d) }
            t += n &* d
            s += Int(n)
        }
        return max(0, sampleCount - 1)
    }

    /// Sync sample nearest to a sample index. Without stss every sample is sync.
    func nearestSync(to sample: Int) -> Int {
        guard let stss, stss.count >= 4 else { return sample }
        var lo = 0, hi = stss.count / 4 - 1
        while lo < hi {
            let mid = (lo + hi) / 2
            if Int(stss.u32(mid * 4)) - 1 < sample { lo = mid + 1 } else { hi = mid }
        }
        let after = Int(stss.u32(lo * 4)) - 1
        if lo > 0 {
            let before = Int(stss.u32((lo - 1) * 4)) - 1
            if sample - before < after - sample { return before }
        }
        return after
    }
}

final class Movie {
    let storage: ReadBuffer
    let moov: Bytes
    var mvhdTimescale: UInt32 = 0
    var mvhdDuration: UInt64 = 0
    var mvhdCreation: UInt64 = 0
    var tracks: [Track] = []
    var udta: Bytes?
    var meta: Bytes?
    /// `uuid` boxes directly inside `moov`. Canon keeps its own record in one.
    var uuids: [Bytes] = []
    /// A top-level `meta` box next to `moov`, where Sony puts the clip's XML when it isn't beside the clip. Small, and usually
    /// already in memory with `moov`.
    var outerMeta: Bytes?
    var outerMetaStorage: ReadBuffer?
    var fragmented = false

    init(storage: ReadBuffer, moov: Bytes) {
        self.storage = storage
        self.moov = moov
    }

    var video: Track? {
        tracks.filter { $0.handler == fourCC("vide") && $0.sampleCount > 0 }
            .max { $0.sampleCount * Int(max($0.tkhdWidth, 1)) < $1.sampleCount * Int(max($1.tkhdWidth, 1)) }
    }
    var audio: [Track] { tracks.filter { $0.handler == fourCC("soun") && $0.sampleCount > 0 } }
    var timecodeTrack: Track? { tracks.first { $0.format == fourCC("tmcd") && $0.sampleCount > 0 } }
}

enum MP4Error: Error, CustomStringConvertible {
    case notMP4, noMoov, truncated, unsupported(String), io(String), needsFFmpeg(String)
    var description: String {
        switch self {
        case .notMP4: return "not an MP4 or MOV file"
        case .noMoov: return "no movie header in the file"
        case .truncated: return "file is truncated or its tables are damaged"
        case .unsupported(let message), .io(let message), .needsFFmpeg(let message): return message
        }
    }
    /// A system read failure may be a pulled cable, and ffmpeg may be installed tomorrow, so neither
    /// must be remembered as a verdict on the clip.
    var isTransient: Bool {
        switch self {
        case .io, .needsFFmpeg: return true
        default: return false
        }
    }
}

let ioAlign = 16 * 1024

/// A read buffer whose payload sits inside a page-aligned allocation.
final class ReadBuffer {
    private let raw: UnsafeMutableRawPointer
    let view: UnsafePointer<UInt8>
    let count: Int
    init(raw: UnsafeMutableRawPointer, skip: Int, count: Int) {
        self.raw = raw
        view = UnsafePointer((raw + skip).assumingMemoryBound(to: UInt8.self))
        self.count = count
    }
    deinit { free(raw) }
    var bytes: Bytes { Bytes(base: view, count: count) }
}

/// Read-only file handle. Reads are page-aligned with F_NOCACHE, so a scan of a thousand clips
/// leaves Premiere's file cache alone and costs no extra latency (measured: 2.15 against 2.25 ms
/// for a random 1.2 MB read over USB).
final class MediaFile {
    let fd: Int32
    let size: Int64
    let mtime: Double
    /// Bytes this handle has read from the disk, page rounding included. For the trace.
    private(set) var bytesRead = 0
    /// Reads this handle has made. For the trace.
    private(set) var reads = 0

    init(path: String) throws {
        fd = open(path, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else { throw MP4Error.io(String(cString: strerror(errno))) }
        var st = stat()
        guard fstat(fd, &st) == 0 else {
            let msg = String(cString: strerror(errno))
            close(fd)
            throw MP4Error.io(msg)
        }
        size = Int64(st.st_size)
        mtime = Double(st.st_mtimespec.tv_sec) + Double(st.st_mtimespec.tv_nsec) / 1e9
        _ = fcntl(fd, F_RDAHEAD, 0)
        _ = fcntl(fd, F_NOCACHE, 1)
    }
    deinit { close(fd) }

    /// Reads a byte range, widening it to page boundaries. Short at end of file.
    func read(at off: Int64, count: Int) throws -> ReadBuffer {
        guard off >= 0, count >= 0, count <= 1 << 30, off <= size else { throw MP4Error.truncated }
        let start = off & ~Int64(ioAlign - 1)
        let skip = Int(off - start)
        let wanted = (skip + count + ioAlign - 1) & ~(ioAlign - 1)
        var mem: UnsafeMutableRawPointer?
        guard posix_memalign(&mem, ioAlign, max(wanted, ioAlign)) == 0, let raw = mem else {
            throw MP4Error.io("out of memory")
        }
        var done = 0
        while done < wanted {
            let n = pread(fd, raw + done, wanted - done, start + Int64(done))
            if n < 0 {
                if errno == EINTR { continue }
                let msg = String(cString: strerror(errno))
                free(raw)
                throw MP4Error.io(msg)
            }
            if n == 0 { break }
            done += n
        }
        bytesRead += done
        reads += 1
        return ReadBuffer(raw: raw, skip: skip, count: max(0, min(count, done - skip)))
    }
}

/// Finds and loads `moov`. Sony cameras put it after mdat, so the usual cost is two reads.
func loadMovie(_ f: MediaFile) throws -> Movie {
    let head = try f.read(at: 0, count: ioAlign)
    guard head.count >= 8 else { throw MP4Error.notMP4 }
    let hv = head.bytes
    let known: Set<UInt32> = [fourCC("ftyp"), fourCC("moov"), fourCC("mdat"), fourCC("wide"), fourCC("free"),
                              fourCC("skip"), fourCC("uuid"), fourCC("pnot"), fourCC("PICT"), fourCC("styp")]
    guard known.contains(hv.u32(4)) else { throw MP4Error.notMP4 }

    var pos: Int64 = 0
    var fragmented = false
    var outerMeta: ReadBuffer?
    var window = head
    var windowStart: Int64 = 0
    while pos + 8 <= f.size {
        if pos + 16 > windowStart + Int64(window.count) {
            windowStart = pos
            window = try f.read(at: pos, count: ioAlign)
            guard window.count >= 8 else { break }
        }
        let v = window.bytes
        let at = Int(pos - windowStart)
        var size = Int64(v.u32(at))
        let type = v.u32(at + 4)
        var hdr = 8
        if size == 1 {
            size = Int64(truncatingIfNeeded: v.u64(at + 8))
            hdr = 16
        } else if size == 0 {
            size = f.size - pos
        }
        guard size >= Int64(hdr) else { break }
        if type == fourCC("moov") {
            guard pos + size <= f.size, size < 1 << 30 else { throw MP4Error.truncated }
            let bodySize = Int(size) - hdr
            let whole: ReadBuffer
            let body: Bytes
            if at + Int(size) <= window.count {
                whole = window
                body = v.sub(at + hdr, bodySize)
            } else {
                whole = try f.read(at: pos + Int64(hdr), count: bodySize)
                guard whole.count == bodySize else { throw MP4Error.truncated }
                body = whole.bytes
            }
            let movie = Movie(storage: whole, moov: body)
            parseMoov(movie)
            movie.fragmented = fragmented || movie.fragmented
            if let earlier = outerMeta {
                (movie.outerMeta, movie.outerMetaStorage) = (earlier.bytes, earlier)
            } else if at + Int(size) + 8 <= window.count, v.u32(at + Int(size) + 4) == fourCC("meta") {
                // Sony writes it right after `moov`, at the end of the file, so it's usually in the read already made.
                let metaSize = Int(v.u32(at + Int(size)))
                if metaSize > 8, metaSize <= outerMetaLimit {
                    if at + Int(size) + metaSize <= window.count {
                        (movie.outerMeta, movie.outerMetaStorage) = (v.sub(at + Int(size), metaSize), window)
                    } else if let b = try? f.read(at: pos + size, count: metaSize), b.count == metaSize {
                        (movie.outerMeta, movie.outerMetaStorage) = (b.bytes, b)
                    }
                }
            }
            return movie
        }
        if type == fourCC("moof") { fragmented = true }
        if type == fourCC("meta"), outerMeta == nil, size > 8, size <= Int64(outerMetaLimit),
           let b = try? f.read(at: pos, count: Int(size)), b.count == Int(size) {
            outerMeta = b
        }
        pos += size
    }
    throw MP4Error.noMoov
}

/// A top-level `meta` box bigger than this isn't read. Sony's is about 10 KB.
private let outerMetaLimit = 1 << 20

private func parseMoov(_ m: Movie) {
    for box in BoxIterator(m.moov) {
        switch box.type {
        case fourCC("mvhd"):
            let v = box.body.u8(0)
            if v == 1 {
                m.mvhdCreation = box.body.u64(4)
                m.mvhdTimescale = box.body.u32(20)
                m.mvhdDuration = box.body.u64(24)
            } else {
                m.mvhdCreation = UInt64(box.body.u32(4))
                m.mvhdTimescale = box.body.u32(12)
                m.mvhdDuration = UInt64(box.body.u32(16))
            }
        case fourCC("trak"):
            if let t = parseTrak(box.body) { m.tracks.append(t) }
        case fourCC("udta"): m.udta = box.body
        case fourCC("meta"): m.meta = box.body
        case fourCC("uuid"): m.uuids.append(box.body)
        case fourCC("mvex"): m.fragmented = true
        default: break
        }
    }
}

private func parseTrak(_ b: Bytes) -> Track? {
    let t = Track()
    for box in BoxIterator(b) {
        switch box.type {
        case fourCC("tkhd"):
            let v = box.body.u8(0)
            let base = v == 1 ? 40 : 28   // offset of layer field after timing fields
            let matrixAt = base + 12
            t.matrix = (box.body.i32(matrixAt), box.body.i32(matrixAt + 4),
                        box.body.i32(matrixAt + 12), box.body.i32(matrixAt + 16))
            t.tkhdWidth = Double(box.body.u32(matrixAt + 36)) / 65536
            t.tkhdHeight = Double(box.body.u32(matrixAt + 40)) / 65536
        case fourCC("mdia"):
            parseMdia(box.body, t)
        default: break
        }
    }
    return t
}

private func parseMdia(_ b: Bytes, _ t: Track) {
    for box in BoxIterator(b) {
        switch box.type {
        case fourCC("mdhd"):
            let v = box.body.u8(0)
            if v == 1 {
                t.timescale = box.body.u32(20)
                t.mdhdDuration = box.body.u64(24)
            } else {
                t.timescale = box.body.u32(12)
                t.mdhdDuration = UInt64(box.body.u32(16))
            }
        case fourCC("hdlr"):
            t.handler = box.body.u32(8)
        case fourCC("minf"):
            for mi in BoxIterator(box.body) where mi.type == fourCC("stbl") { parseStbl(mi.body, t) }
        default: break
        }
    }
}

private func parseStbl(_ b: Bytes, _ t: Track) {
    for box in BoxIterator(b) {
        let body = box.body
        switch box.type {
        case fourCC("stsd"):
            // First sample description only: FullBox header, count, then the entry.
            if body.u32(4) >= 1, body.valid(8, 8) {
                let size = Int(body.u32(8))
                if body.valid(8, size), size >= 8 {
                    t.format = body.u32(12)
                    t.stsdEntry = body.sub(16, size - 8)
                }
            }
        case fourCC("stts"):
            let n = Int(body.u32(4))
            t.stts = body.sub(8, min(n &* 8, max(0, body.count - 8)))
        case fourCC("stsc"):
            let n = Int(body.u32(4))
            t.stsc = body.sub(8, min(n &* 12, max(0, body.count - 8)))
        case fourCC("stss"):
            let n = Int(body.u32(4))
            t.stss = body.sub(8, min(n &* 4, max(0, body.count - 8)))
        case fourCC("stsz"):
            t.stszFixed = body.u32(4)
            t.sampleCount = Int(body.u32(8))
            if t.stszFixed == 0 {
                t.sampleCount = min(t.sampleCount, max(0, body.count - 12) / 4)
                t.sizes = body.sub(12, t.sampleCount * 4)
            }
        case fourCC("stco"):
            let n = Int(body.u32(4))
            t.chunkOffsets = body.sub(8, min(n &* 4, max(0, body.count - 8)))
            t.chunkOffsetWide = false
        case fourCC("co64"):
            let n = Int(body.u32(4))
            t.chunkOffsets = body.sub(8, min(n &* 8, max(0, body.count - 8)))
            t.chunkOffsetWide = true
        default: break
        }
    }
}
