import Foundation

struct Embedded {
    var make: String?
    var model: String?
    var lens: String?
    var created: String?
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
            default: break
            }
        }
    }
    // The container's own time is UTC, so it's the last resort, behind anything that knows the camera's zone.
    if e.created == nil { e.created = iso1904(m.mvhdCreation) }
    return e
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
    let s = String(decoding: UnsafeBufferPointer(start: b.view, count: b.count), as: UTF8.self)
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
