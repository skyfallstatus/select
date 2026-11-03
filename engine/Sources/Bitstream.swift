import Foundation

/// Reads H.264 parameter sets and codec boxes. No slice data is touched.
struct CodecInfo {
    var codec: String
    var bitDepth: Int?
    var chroma: String?

    /// "H.264 10-bit 4:2:2", for messages.
    var displayName: String {
        let names = ["h264": "H.264", "hevc": "HEVC", "prores": "ProRes", "prores_raw": "ProRes RAW", "av1": "AV1", "vp9": "VP9",
                     "mpeg4": "MPEG-4", "mjpeg": "Motion JPEG", "dnxhd": "DNx"]
        var parts = [names[codec] ?? codec]
        if let bitDepth { parts.append("\(bitDepth)-bit") }
        if let chroma, chroma.count == 3 { parts.append(chroma.map(String.init).joined(separator: ":")) }
        return parts.joined(separator: " ")
    }
}

private struct BitReader {
    let bytes: [UInt8]
    var pos = 0
    init(_ b: [UInt8]) { bytes = b }
    var exhausted: Bool { pos >= bytes.count * 8 }
    mutating func bit() -> Int {
        guard pos < bytes.count * 8 else { return 0 }
        let v = (bytes[pos >> 3] >> UInt8(7 - pos & 7)) & 1
        pos += 1
        return Int(v)
    }
    mutating func bits(_ n: Int) -> Int {
        var v = 0
        for _ in 0..<n { v = v << 1 | bit() }
        return v
    }
    mutating func ue() -> Int {
        var zeros = 0
        while bit() == 0, zeros < 32, !exhausted { zeros += 1 }
        return (1 << zeros) - 1 + bits(zeros)
    }
}

private func chromaName(_ idc: Int) -> String? {
    switch idc {
    case 0: return "400"
    case 1: return "420"
    case 2: return "422"
    case 3: return "444"
    default: return nil
    }
}

private func parseAvcC(_ b: Bytes) -> (Int?, String?) {
    guard b.count >= 8, b.u8(5) & 0x1f >= 1 else { return (nil, nil) }
    let len = Int(b.u16(6))
    guard b.valid(8, len), len >= 4 else { return (nil, nil) }
    var rbsp = [UInt8]()
    rbsp.reserveCapacity(len)
    var zeros = 0
    for i in 1..<len {
        let v = b.u8(8 + i)
        if zeros >= 2, v == 3 {
            zeros = 0
            continue
        }
        zeros = v == 0 ? zeros + 1 : 0
        rbsp.append(v)
    }
    var r = BitReader(rbsp)
    let profile = r.bits(8)
    _ = r.bits(16)
    _ = r.ue()
    let high: Set<Int> = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]
    guard high.contains(profile) else { return (8, "420") }
    let idc = r.ue()
    if idc == 3 { _ = r.bit() }
    let depth = r.ue() + 8
    guard (8...14).contains(depth) else { return (nil, chromaName(idc)) }
    return (depth, chromaName(idc))
}

func codecInfo(_ t: Track) -> CodecInfo {
    let f = t.format
    var name: String
    switch f {
    case fourCC("avc1"), fourCC("avc3"): name = "h264"
    case fourCC("hvc1"), fourCC("hev1"), fourCC("dvh1"), fourCC("dvhe"): name = "hevc"
    case fourCC("apco"), fourCC("apcs"), fourCC("apcn"), fourCC("apch"):
        return CodecInfo(codec: "prores", bitDepth: 10, chroma: "422")
    case fourCC("ap4h"), fourCC("ap4x"):
        return CodecInfo(codec: "prores", bitDepth: 12, chroma: "444")
    case fourCC("aprn"), fourCC("aprh"): name = "prores_raw"
    case fourCC("av01"): name = "av1"
    case fourCC("vp09"): name = "vp9"
    case fourCC("mp4v"): name = "mpeg4"
    case fourCC("jpeg"), fourCC("mjpa"), fourCC("mjpb"): name = "mjpeg"
    case fourCC("AVdh"), fourCC("AVdn"): name = "dnxhd"
    default: name = fourCCString(f).trimmingCharacters(in: .whitespaces).lowercased()
    }
    var info = CodecInfo(codec: name, bitDepth: nil, chroma: nil)
    for b in visualChildren(t) {
        switch b.type {
        case fourCC("avcC"):
            (info.bitDepth, info.chroma) = parseAvcC(b.body)
        case fourCC("hvcC"):
            if b.body.count >= 19 {
                info.chroma = chromaName(Int(b.body.u8(16) & 3))
                info.bitDepth = Int(b.body.u8(17) & 7) + 8
            }
        case fourCC("av1C"):
            if b.body.count >= 3 {
                let v = b.body.u8(2)
                let high = v & 0x40 != 0, twelve = v & 0x20 != 0
                info.bitDepth = twelve ? 12 : (high ? 10 : 8)
                let sx = v & 0x08 != 0, sy = v & 0x04 != 0
                info.chroma = v & 0x10 != 0 ? "400" : (sx && sy ? "420" : (sx ? "422" : "444"))
            }
        case fourCC("vpcC"):
            if b.body.count >= 7 {
                let v = b.body.u8(6)
                info.bitDepth = Int(v >> 4)
                let c = (v >> 1) & 7
                info.chroma = c <= 1 ? "420" : (c == 2 ? "422" : "444")
            }
        default: break
        }
    }
    return info
}

/// Children of the first video sample description.
func visualChildren(_ t: Track) -> BoxIterator {
    BoxIterator(t.stsdEntry.sub(78, max(0, t.stsdEntry.count - 78)))
}

/// Decoder configuration atoms VideoToolbox needs, and any transfer function from `colr`.
func decoderAtoms(_ t: Track) -> [String: Data] {
    var out: [String: Data] = [:]
    let wanted: Set<UInt32> = [fourCC("avcC"), fourCC("hvcC"), fourCC("av1C"), fourCC("vpcC"), fourCC("dvcC"), fourCC("dvvC")]
    for b in visualChildren(t) where wanted.contains(b.type) { out[fourCCString(b.type)] = b.body.data }
    return out
}

/// Only PQ and HLG count: a Rec.709 tag says nothing about what the camera really recorded.
func transferGamma(_ t: Track) -> String? {
    for b in visualChildren(t) where b.type == fourCC("colr") {
        let kind = b.body.u32(0)
        guard kind == fourCC("nclx") || kind == fourCC("nclc") else { continue }
        switch b.body.u16(6) {
        case 16: return "pq"
        case 18: return "hlg"
        default: return nil
        }
    }
    return nil
}
