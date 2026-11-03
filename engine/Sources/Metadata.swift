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
            case "com.apple.quicktime.creationdate": e.created = text
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
            case 0xA964_6179: e.created = e.created ?? qtText(b.body)
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

/// Sony `C0023M01.XML` beside the clip, read with a plain text scan.
func readSidecar(clipPath: String) -> Sidecar? {
    guard clipPath.hasSuffix(".MP4") || clipPath.hasSuffix(".mp4") || clipPath.hasSuffix(".MXF") || clipPath.hasSuffix(".mxf") else {
        return nil
    }
    let path = String(clipPath.dropLast(4)) + "M01.XML"
    guard let f = try? MediaFile(path: path), f.size > 0, f.size < 1 << 20,
          let b = try? f.read(at: 0, count: Int(f.size)) else { return nil }
    let s = String(decoding: UnsafeBufferPointer(start: b.view, count: b.count), as: UTF8.self)
    guard s.contains("NonRealTimeMeta") else { return nil }
    var out = Sidecar()
    out.make = attr(s, tag: "<Device ", name: "manufacturer")
    out.model = attr(s, tag: "<Device ", name: "modelName")
    out.lens = attr(s, tag: "<Lens ", name: "modelName")
    out.created = attr(s, tag: "<CreationDate ", name: "value")
    out.timecode = sonyTimecode(s)
    if let r = s.range(of: "name=\"CaptureGammaEquation\"") {
        let tail = s[r.upperBound...].prefix(120)
        if let a = tail.range(of: "value=\""), let q = tail.range(of: "\"", range: a.upperBound..<tail.endIndex) {
            out.gamma = clean(String(tail[a.upperBound..<q.lowerBound]))
        }
    }
    return out
}
