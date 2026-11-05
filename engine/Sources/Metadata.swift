import Foundation

/// Where `createdAt` came from, for the panel to say in a tooltip.
enum DateSource: String {
    /// The camera's own clock, with its zone: a Sony XML, a QuickTime date key or date atom, or Canon's record.
    case camera
    /// The container's creation time, which is UTC and may be when the file was written or copied rather than shot.
    case container
    /// A date in the file name, used because the container's is more than a day away from it, or missing.
    case fileName
}

struct Embedded {
    var make: String?
    var model: String?
    var lens: String?
    var created: String?
    var createdSource: DateSource?
    /// The container's own date, when a date in the file name was used instead.
    var containerDate: String?
    /// The date came from a file name that gives the day but not the time.
    var dateOnly = false
    var lat: Double?
    var lon: Double?
    var gamma: String?
    var timecode: String?
}

/// `+48.8566+002.3522+035.000/` from ©xyz or the Apple location key.
func parseISO6709(_ s: String) -> (Double, Double)? {
    let chars = Array(s.utf8)
    var parts: [Double] = []
    var i = 0
    while i < chars.count, parts.count < 2 {
        guard chars[i] == 43 || chars[i] == 45 else { break }
        var j = i + 1
        while j < chars.count, (chars[j] >= 48 && chars[j] <= 57) || chars[j] == 46 { j += 1 }
        guard let v = Double(String(decoding: chars[i..<j], as: UTF8.self)) else { return nil }
        parts.append(v)
        i = j
    }
    guard parts.count == 2, abs(parts[0]) <= 90, abs(parts[1]) <= 180 else { return nil }
    return (parts[0], parts[1])
}

/// A date as `2023-11-02T16:45:07+01:00`, or with `Z` for UTC, so the panel can show it in local time. Takes what cameras and
/// muxers write: `T` or a space between date and time, `-` or `:` in the date, a fraction of a second, which is dropped, and
/// `Z`, `+01:00`, `+0100` or `+01`. A time with no offset could be in any zone, so it gives nil and the next source is tried.
func isoDate(_ text: String) -> String? {
    let c = Array(text.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
    func num(_ at: Int, _ n: Int) -> Int? {
        guard at >= 0, at + n <= c.count else { return nil }
        var v = 0
        for i in at..<(at + n) {
            guard c[i] >= 48, c[i] <= 57 else { return nil }
            v = v * 10 + Int(c[i] - 48)
        }
        return v
    }
    guard c.count >= 20, let y = num(0, 4), c[4] == 45 || c[4] == 58, let mo = num(5, 2), c[7] == c[4], let d = num(8, 2),
          c[10] == 84 || c[10] == 32, let h = num(11, 2), c[13] == 58, let mi = num(14, 2), c[16] == 58, let s = num(17, 2),
          (1900...2200).contains(y), (1...12).contains(mo), (1...31).contains(d), h < 24, mi < 60, s <= 60 else { return nil }
    var at = 19
    if c[at] == 46 || c[at] == 44 {
        at += 1
        while at < c.count, c[at] >= 48, c[at] <= 57 { at += 1 }
    }
    guard at < c.count else { return nil }
    var zone = "Z"
    if c[at] == 90 {
        guard at + 1 == c.count else { return nil }
    } else if c[at] == 43 || c[at] == 45 {
        guard let zh = num(at + 1, 2), zh <= 14 else { return nil }
        var end = at + 3, zm = 0
        if end < c.count {
            if c[end] == 58 { end += 1 }
            guard let m = num(end, 2), m < 60 else { return nil }
            zm = m
            end += 2
        }
        guard end == c.count else { return nil }
        zone = String(format: "%@%02d:%02d", c[at] == 43 ? "+" : "-", zh, zm)
    } else {
        return nil
    }
    // A leap second would stop most date parsers, so it reads as the second before.
    return String(format: "%04d-%02d-%02dT%02d:%02d:%02d", y, mo, d, h, mi, min(s, 59)) + zone
}

private func clean(_ s: String?) -> String? {
    guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
    return t
}

/// QuickTime text atom: 16-bit length, 16-bit language, text.
private func qtText(_ b: Bytes) -> String? {
    let n = Int(b.u16(0))
    return n > 0 && b.valid(4, n) ? clean(b.string(4, n)) : nil
}

private func parseKeyed(_ meta: Bytes, into e: inout Embedded) {
    var keys: [String] = []
    var ilst: Bytes?
    for b in BoxIterator(meta) {
        if b.type == fourCC("keys") {
            var at = 8
            for _ in 0..<min(Int(b.body.u32(4)), 256) {
                let size = Int(b.body.u32(at))
                guard size >= 8, b.body.valid(at, size) else { break }
                keys.append(b.body.string(at + 8, size - 8) ?? "")
                at += size
            }
        } else if b.type == fourCC("ilst") {
            ilst = b.body
        }
    }
    guard let ilst else { return }
    for item in BoxIterator(ilst) {
        let idx = Int(item.type) - 1
        guard idx >= 0, idx < keys.count else { continue }
        // Only text is wanted. Skip anything large, like the DJI cover JPEG.
        guard item.body.count < 4096 else { continue }
        for d in BoxIterator(item.body) where d.type == fourCC("data") {
            guard d.body.u32(0) == 1, let text = clean(d.body.string(8, d.body.count - 8)) else { continue }
            switch keys[idx] {
            case "com.apple.quicktime.make", "com.android.manufacturer": e.make = text
            case "com.apple.quicktime.model", "com.android.model": e.model = text
            case "com.apple.quicktime.camera.lens_model": e.lens = text
            case "com.apple.quicktime.creationdate": e.created = isoDate(text) ?? e.created
            case "com.apple.quicktime.location.ISO6709":
                if let (la, lo) = parseISO6709(text) { (e.lat, e.lon) = (la, lo) }
            default: break
            }
        }
    }
}

private func iso1904(_ t: UInt64) -> String? {
    let offset: UInt64 = 2_082_844_800
    guard t > offset else { return nil }
    let unix = time_t(t - offset)
    var tmv = tm()
    gmtime_r([unix], &tmv)
    guard tmv.tm_year + 1900 >= 1990 else { return nil }
    return String(format: "%04d-%02d-%02dT%02d:%02d:%02dZ", tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
                  tmv.tm_hour, tmv.tm_min, tmv.tm_sec)
}

func embeddedMetadata(_ m: Movie) -> Embedded {
    var e = Embedded()
    var canon = CanonRecord()
    if let meta = m.meta { parseKeyed(meta, into: &e) }
    if let udta = m.udta {
        for b in BoxIterator(udta) {
            switch b.type {
            case 0xA96D_616B: e.make = e.make ?? qtText(b.body)
            case 0xA96D_6F64: e.model = e.model ?? qtText(b.body)
            case 0xA964_6179: e.created = e.created ?? qtText(b.body).flatMap(isoDate)
            case 0xA978_797A:
                if e.lat == nil, let t = qtText(b.body), let (la, lo) = parseISO6709(t) { (e.lat, e.lon) = (la, lo) }
            case fourCC("meta"):
                // iTunes-style meta is a FullBox; the QuickTime one is not.
                parseKeyed(b.body.sub(4, max(0, b.body.count - 4)), into: &e)
            case fourCC("Xtra"):
                if e.model == nil, let model = djiModelName(b.body) {
                    e.model = model
                    e.make = e.make ?? "DJI"
                }
            // 3GPP-style maker and model, which Canon writes: version and flags, a language code, then the text.
            case fourCC("manu"): e.make = e.make ?? userText(b.body)
            case fourCC("modl"): e.model = e.model ?? userText(b.body)
            case fourCC("CNMN"): canon.model = canon.model ?? clean(b.body.string(0, b.body.count))
            case fourCC("CNTH"): readCanonThumbnail(b.body, into: &canon)
            default: break
            }
        }
    }
    for u in m.uuids where u.count > 16 && u.sub(0, 16).data == canonUUID {
        readCanonBoxes(u.sub(16, u.count - 16), into: &canon)
    }
    e.make = e.make ?? canon.make
    e.model = e.model ?? canon.model
    e.lens = e.lens ?? canon.lens
    if e.created == nil { e.created = canon.created }
    if e.created != nil { e.createdSource = .camera }
    // The container's own time is UTC, so it's the last resort, behind anything that knows the camera's zone.
    if e.created == nil, let utc = iso1904(m.mvhdCreation) {
        e.created = utc
        e.createdSource = .container
    }
    return e
}

/// The text of a 3GPP user data box: 4 bytes of version and flags, a 2-byte language, then the string.
private func userText(_ b: Bytes) -> String? { b.count > 6 ? clean(b.string(6, b.count - 6)) : nil }

// MARK: Canon

/// Canon's `uuid` box inside `moov`, on EOS R cameras: it holds `CNCV`, `CNTH` and more.
private let canonUUID = Data([0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48])

/// What Canon's own boxes say about the camera, the lens and when the clip was shot.
struct CanonRecord {
    var make: String?
    var model: String?
    var lens: String?
    var created: String?
}

private func readCanonBoxes(_ body: Bytes, into c: inout CanonRecord) {
    for b in BoxIterator(body) {
        switch b.type {
        case fourCC("CNTH"): readCanonThumbnail(b.body, into: &c)
        // TIFF blocks, as in Canon's raw stills: CMT1 holds the main directory, CMT2 the EXIF one.
        case fourCC("CMT1"), fourCC("CMT2"): readTIFF(b.body, into: &c)
        default: break
        }
    }
}

/// `CNTH` holds `CNDA`, a small JPEG whose EXIF block names the camera, the lens and the time with its offset.
private func readCanonThumbnail(_ body: Bytes, into c: inout CanonRecord) {
    for b in BoxIterator(body) where b.type == fourCC("CNDA") {
        let j = b.body
        guard j.u16(0) == 0xFFD8 else { continue }
        // JPEG segments up to the image data: an APP1 that starts with "Exif" holds a TIFF block.
        var at = 2
        while j.valid(at, 4), j.u8(at) == 0xFF {
            let marker = j.u8(at + 1)
            if marker == 0xDA || marker == 0xD9 { break }
            let length = Int(j.u16(at + 2))
            guard length >= 2, j.valid(at + 2, length) else { break }
            if marker == 0xE1, length >= 8, j.u32(at + 4) == fourCC("Exif") {
                readTIFF(j.sub(at + 10, length - 8), into: &c)
            }
            at += 2 + length
        }
    }
}

/// Reads the text tags this engine wants from a TIFF block: maker and model from the first directory, lens, the time it was
/// shot and its offset from the EXIF directory, which may also be the first one. Every read is bounds-checked.
private func readTIFF(_ t: Bytes, into c: inout CanonRecord) {
    let little: Bool
    switch t.u16(0) {
    case 0x4949: little = true
    case 0x4D4D: little = false
    default: return
    }
    func u16(_ o: Int) -> Int { little ? Int(t.u8(o)) | Int(t.u8(o + 1)) << 8 : Int(t.u16(o)) }
    func u32(_ o: Int) -> Int { little ? u16(o) | u16(o + 2) << 16 : Int(t.u32(o)) }
    guard u16(2) == 42 else { return }
    var text: [Int: String] = [:]
    func directory(_ start: Int, depth: Int) {
        guard depth < 3, t.valid(start, 2) else { return }
        let n = u16(start)
        guard n <= 512 else { return }
        for i in 0..<n {
            let e = start + 2 + i * 12
            guard t.valid(e, 12) else { return }
            let tag = u16(e), type = u16(e + 2), count = u32(e + 4)
            if tag == 0x8769 {
                directory(u32(e + 8), depth: depth + 1)
            } else if type == 2, count > 0, count <= 256 {
                let at = count <= 4 ? e + 8 : u32(e + 8)
                if text[tag] == nil, let s = clean(t.string(at, count)) { text[tag] = s }
            }
        }
    }
    directory(u32(4), depth: 0)
    c.make = c.make ?? text[0x010F]
    c.model = c.model ?? text[0x0110]
    c.lens = c.lens ?? text[0xA434]
    // DateTimeOriginal with OffsetTimeOriginal. Without the offset the time could be in any zone, so it's passed over.
    if c.created == nil, let when = text[0x9003], let zone = text[0x9011] { c.created = isoDate(when + zone) }
}

/// DJI stores `model_name:PP-101` as UTF-16 inside udta/Xtra.
private func djiModelName(_ b: Bytes) -> String? {
    let needle = Array("model_name:".utf16)
    var i = 0
    let n = b.count
    while i + needle.count * 2 < n {
        var hit = true
        for (k, c) in needle.enumerated() where UInt16(b.u8(i + k * 2)) | UInt16(b.u8(i + k * 2 + 1)) << 8 != c {
            hit = false
            break
        }
        if hit {
            var j = i + needle.count * 2
            var out: [UInt16] = []
            while j + 1 < n {
                let c = UInt16(b.u8(j)) | UInt16(b.u8(j + 1)) << 8
                if c == 0 || c == 59 { break }
                out.append(c)
                j += 2
            }
            return clean(String(decoding: out, as: UTF16.self))
        }
        i += 1
    }
    return nil
}

func formatTimecode(frameNumber: Int64, nominal: Int, drop: Bool) -> String? {
    guard nominal > 0, frameNumber >= 0 else { return nil }
    var f = frameNumber
    if drop, nominal == 30 || nominal == 60 {
        // Standard drop-frame: skip 2 (or 4) numbers each minute except every tenth.
        let d = Int64(nominal == 30 ? 2 : 4)
        let per10 = Int64(nominal) * 600 - 9 * d
        let perMin = Int64(nominal) * 60 - d
        let tens = f / per10
        let rest = f % per10
        f += 9 * d * tens
        f += d * ((rest - d) / perMin)
    }
    let n = Int64(nominal)
    let ff = f % n, ss = (f / n) % 60, mm = (f / n / 60) % 60, hh = (f / n / 3600) % 24
    return String(format: "%02lld:%02lld:%02lld%@%02lld", hh, mm, ss, drop ? ";" : ":", ff)
}

/// Start timecode from a `tmcd` track. One small read.
func trackTimecode(_ m: Movie, _ f: MediaFile) -> String? {
    guard let t = m.timecodeTrack, let off = t.sampleOffset(0) else { return nil }
    let e = t.stsdEntry
    let flags = e.u32(12)
    let nominal = Int(e.u8(24))
    guard let b = try? f.read(at: off, count: 4), b.count == 4 else { return nil }
    let v = b.bytes.u32(0)
    guard flags & 0x80 == 0 else { return nil }
    return formatTimecode(frameNumber: Int64(v), nominal: nominal, drop: flags & 1 != 0)
}

struct Sidecar {
    var make: String?
    var model: String?
    var lens: String?
    var gamma: String?
    var primaries: String?
    var created: String?
    var timecode: String?
}

private func attr(_ s: String, tag: String, name: String) -> String? {
    guard let t = s.range(of: tag) else { return nil }
    guard let end = s.range(of: ">", range: t.upperBound..<s.endIndex) else { return nil }
    // Keeps the leading space, so the first attribute of a tag matches like the others.
    let scope = " " + s[t.upperBound..<end.lowerBound]
    guard let a = scope.range(of: " \(name)=\"") else { return nil }
    guard let q = scope.range(of: "\"", range: a.upperBound..<scope.endIndex) else { return nil }
    return clean(String(scope[a.upperBound..<q.lowerBound]))
}

/// Sony LTC is BCD bytes in frames, seconds, minutes, hours order. On half-step rates (50p, 60p)
/// the LTC counts 25 or 30 with a flag for the second frame of each pair.
private func sonyTimecode(_ s: String) -> String? {
    guard let raw = attr(s, tag: "<LtcChange ", name: "value"), raw.utf8.count == 8,
          let v = UInt32(raw, radix: 16) else { return nil }
    let ff = (v >> 24) & 0xff, ss = (v >> 16) & 0xff, mm = (v >> 8) & 0xff, hh = v & 0xff
    func bcd(_ x: UInt32, _ mask: UInt32) -> Int { Int((x & mask) >> 4) * 10 + Int(x & mask & 0xf) }
    let half = attr(s, tag: "<LtcChangeTable", name: "halfStep") == "true"
    let drop = ff & 0x40 != 0 || attr(s, tag: "<LtcChangeTable", name: "dropFrame") == "true"
    var frames = bcd(ff, 0x3f)
    if half { frames = frames * 2 + (hh & 0x80 != 0 ? 1 : 0) }
    return String(format: "%02d:%02d:%02d%@%02d", bcd(hh, 0x3f), bcd(mm, 0x7f), bcd(ss, 0x7f), drop ? ";" : ":", frames)
}

/// Where Sony keeps a clip's sidecar: `C0023M01.XML` beside `C0023.MP4`. Nil for a file that never has one.
func sidecarPath(clipPath: String) -> String? {
    guard clipPath.hasSuffix(".MP4") || clipPath.hasSuffix(".mp4") || clipPath.hasSuffix(".MXF") || clipPath.hasSuffix(".mxf") else {
        return nil
    }
    return String(clipPath.dropLast(4)) + "M01.XML"
}

/// Sony `C0023M01.XML` beside the clip, read with a plain text scan.
func readSidecar(clipPath: String) -> Sidecar? {
    guard let path = sidecarPath(clipPath: clipPath),
          let f = try? MediaFile(path: path), f.size > 0, f.size < 1 << 20,
          let b = try? f.read(at: 0, count: Int(f.size)) else { return nil }
    return parseNonRealTimeMeta(String(decoding: UnsafeBufferPointer(start: b.view, count: b.count), as: UTF8.self))
}

/// The same XML that Sony writes beside a clip, found inside the file: in a top-level `meta` box of an MP4, or near the
/// start of an MXF. A clip copied without its sidecar still has it.
func embeddedSidecar(_ b: Bytes) -> Sidecar? {
    let open = Array("<NonRealTimeMeta".utf8), close = Array("</NonRealTimeMeta>".utf8)
    func find(_ needle: [UInt8], from: Int) -> Int? {
        guard needle.count <= b.count else { return nil }
        var i = from
        while i + needle.count <= b.count {
            if b.base[i] == needle[0], (0..<needle.count).allSatisfy({ b.base[i + $0] == needle[$0] }) { return i }
            i += 1
        }
        return nil
    }
    guard let start = find(open, from: 0), let end = find(close, from: start) else { return nil }
    return parseNonRealTimeMeta(String(decoding: UnsafeBufferPointer(start: b.base + start, count: end + close.count - start),
                                       as: UTF8.self))
}

func parseNonRealTimeMeta(_ s: String) -> Sidecar? {
    guard s.contains("NonRealTimeMeta") else { return nil }
    var out = Sidecar()
    out.make = attr(s, tag: "<Device ", name: "manufacturer")
    out.model = attr(s, tag: "<Device ", name: "modelName")
    out.lens = attr(s, tag: "<Lens ", name: "modelName")
    out.created = attr(s, tag: "<CreationDate ", name: "value")
    out.timecode = sonyTimecode(s)
    func item(_ name: String) -> String? {
        guard let r = s.range(of: "name=\"\(name)\"") else { return nil }
        let tail = s[r.upperBound...].prefix(120)
        guard let a = tail.range(of: "value=\""), let q = tail.range(of: "\"", range: a.upperBound..<tail.endIndex) else { return nil }
        return clean(String(tail[a.upperBound..<q.lowerBound]))
    }
    out.gamma = item("CaptureGammaEquation")
    out.primaries = item("CaptureColorPrimaries")
    return out
}

// MARK: Dates in file names

/// A date some cameras and phones put in the file name. `local` is a wall-clock time with no zone, `dayOnly` a date with no time.
struct NameDate {
    var year = 0, month = 0, day = 0, hour = 12, minute = 0, second = 0
    var utc = false
    var dayOnly = false
}

/// DJI_20250906021200_0013_D.MP4 (the camera's time), PXL_20250906_021200123.mp4 (UTC, as Google's camera names them),
/// VID_20250906_021200.mp4 (the phone's time), and the reel and clip names of cinema cameras, A001C001_250906_R1AB.mov from
/// ARRI or A064C001_250906QL.MP4 from Sony, which give the day only.
func nameDate(_ name: String) -> NameDate? {
    let c = Array(name.utf8)
    func digits(_ at: Int, _ n: Int) -> Int? {
        guard at >= 0, at + n <= c.count else { return nil }
        var v = 0
        for i in at..<(at + n) {
            guard c[i] >= 48, c[i] <= 57 else { return nil }
            v = v * 10 + Int(c[i] - 48)
        }
        return v
    }
    func prefix(_ p: String) -> Bool { name.hasPrefix(p) }
    var d = NameDate()
    if prefix("DJI_"), let y = digits(4, 4), let mo = digits(8, 2), let da = digits(10, 2), let h = digits(12, 2),
       let mi = digits(14, 2), let se = digits(16, 2) {
        (d.year, d.month, d.day, d.hour, d.minute, d.second) = (y, mo, da, h, mi, se)
    } else if prefix("PXL_") || prefix("VID_"), let y = digits(4, 4), let mo = digits(8, 2), let da = digits(10, 2),
              c.count > 12, c[12] == 95, let h = digits(13, 2), let mi = digits(15, 2), let se = digits(17, 2) {
        (d.year, d.month, d.day, d.hour, d.minute, d.second) = (y, mo, da, h, mi, se)
        d.utc = prefix("PXL_")
    } else if c.count >= 15, c[0] >= 65, c[0] <= 90, digits(1, 3) != nil, c[4] == 67, digits(5, 3) != nil, c[8] == 95,
              let y = digits(9, 2), let mo = digits(11, 2), let da = digits(13, 2) {
        (d.year, d.month, d.day) = (2000 + y, mo, da)
        d.dayOnly = true
    } else {
        return nil
    }
    guard (1990...2200).contains(d.year), (1...12).contains(d.month), (1...31).contains(d.day), d.hour < 24, d.minute < 60,
          d.second < 60 else { return nil }
    return d
}

/// Seconds since 1970 for a date this engine wrote: `2023-11-02T16:45:07Z` or with `+01:00`.
func instant(_ iso: String) -> Double? {
    let c = Array(iso.utf8)
    guard c.count >= 20 else { return nil }
    func num(_ at: Int, _ n: Int) -> Int { (at..<(at + n)).reduce(0) { $0 * 10 + Int(c[$1]) - 48 } }
    var t = tm()
    t.tm_year = Int32(num(0, 4) - 1900)
    t.tm_mon = Int32(num(5, 2) - 1)
    t.tm_mday = Int32(num(8, 2))
    t.tm_hour = Int32(num(11, 2))
    t.tm_min = Int32(num(14, 2))
    t.tm_sec = Int32(num(17, 2))
    var at = Double(timegm(&t))
    if c[19] == 43 || c[19] == 45, c.count >= 25 {
        let offset = Double(num(20, 2) * 3600 + num(23, 2) * 60)
        at -= c[19] == 43 ? offset : -offset
    }
    return at
}

/// The name's date as an instant and as text with its zone. A wall-clock time is read in this Mac's zone, as it was on that
/// date. A day with no time is put at noon, so it stays on its day in any zone near this Mac's.
private func settle(_ d: NameDate) -> (at: Double, text: String) {
    var t = tm()
    t.tm_year = Int32(d.year - 1900)
    t.tm_mon = Int32(d.month - 1)
    t.tm_mday = Int32(d.day)
    t.tm_hour = Int32(d.dayOnly ? 12 : d.hour)
    t.tm_min = Int32(d.dayOnly ? 0 : d.minute)
    t.tm_sec = Int32(d.dayOnly ? 0 : d.second)
    let wall = Double(timegm(&t))
    var offset = 0
    if !d.utc {
        // The zone's offset at that moment, found from the wall time and checked once, for the days clocks change.
        offset = TimeZone.current.secondsFromGMT(for: Date(timeIntervalSince1970: wall))
        offset = TimeZone.current.secondsFromGMT(for: Date(timeIntervalSince1970: wall - Double(offset)))
    }
    let zone = d.utc ? "Z" : String(format: "%@%02d:%02d", offset < 0 ? "-" : "+", abs(offset) / 3600, abs(offset) % 3600 / 60)
    let text = String(format: "%04d-%02d-%02dT%02d:%02d:%02d", d.year, d.month, d.day, t.tm_hour, t.tm_min, t.tm_sec) + zone
    return (wall - Double(offset), text)
}

/// A copied or re-rendered file often carries the copy's date in its container. When the file name holds a date more than a
/// day away from it, or there's no date at all, the name's date is used. A camera's own date, with its zone, always stands.
/// The container's date is kept in `containerDate` when the name's replaces it.
func preferNameDate(_ meta: inout Embedded, name: String) {
    guard meta.createdSource != .camera, let d = nameDate(name) else { return }
    let fromName = settle(d)
    if let current = meta.created, let at = instant(current), abs(at - fromName.at) <= 86400 { return }
    meta.containerDate = meta.created
    meta.created = fromName.text
    meta.createdSource = .fileName
    meta.dateOnly = d.dayOnly
}

/// What a Sony XML says wins over what the file's other boxes say: it's the camera's own record. A date in it counts only
/// with its zone.
func applySidecar(_ side: Sidecar?, to meta: inout Embedded) {
    guard let side else { return }
    meta.lens = side.lens ?? meta.lens
    meta.make = side.make ?? meta.make
    meta.model = side.model ?? meta.model
    if let date = side.created.flatMap(isoDate) {
        meta.created = date
        meta.createdSource = .camera
    }
}

/// A camera's name from its maker and model, said once: Canon's model is already "Canon EOS R6".
func cameraName(make: String?, model: String?) -> String? {
    guard let model else { return make }
    guard let make, !model.lowercased().hasPrefix(make.lowercased()) else { return model }
    return make + " " + model
}
