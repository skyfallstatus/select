import Foundation

// Sony's `rtmd` data track carries a block of tagged values with every frame: exposure, gyro, accelerometer.
// A few short runs of it are read straight from the sample table, never the whole track. Everything here reads
// through the bounds-checked `Bytes`, because this is a file talking and the build has no runtime checks.

/// One contiguous run of samples in the track, usually one chunk.
struct RtmdWindow {
    let offset: Int64
    let sizes: [Int]
}

struct RtmdPlan {
    let windows: [RtmdWindow]
}

/// Three runs of about half a second, one chunk each, tell a tripod from a hand for about the price of one keyframe.
private let rtmdWindowCount = 3
private let rtmdMaxSamplesPerWindow = 32
private let rtmdMaxSampleBytes = 1 << 18
private let rtmdMaxReadings = 1 << 15

func rtmdPlan(_ m: Movie) -> RtmdPlan? {
    guard let t = m.tracks.first(where: { $0.format == fourCC("rtmd") && $0.sampleCount > 0 }) else { return nil }
    var windows: [RtmdWindow] = []
    var seen = Set<Int64>()
    for n in 0..<rtmdWindowCount {
        let sample = Int((Double(n) + 0.5) / Double(rtmdWindowCount) * Double(t.sampleCount))
        guard let loc = t.locate(sample), loc.indexInChunk <= sample else { continue }
        let first = sample - loc.indexInChunk
        let count = min(loc.samplesInChunk, rtmdMaxSamplesPerWindow, t.sampleCount - first)
        guard count > 0, let offset = t.sampleOffset(first), !seen.contains(offset) else { continue }
        let sizes = (first..<(first + count)).map { t.sampleSize($0) }
        guard sizes.allSatisfy({ $0 > 0 && $0 <= rtmdMaxSampleBytes }) else { continue }
        seen.insert(offset)
        windows.append(RtmdWindow(offset: offset, sizes: sizes))
    }
    return windows.isEmpty ? nil : RtmdPlan(windows: windows)
}

/// Walks the tags of one sample. A hostile sample can only end the walk early: `pos` always grows.
func walkRtmd(_ s: Bytes, visit: (UInt16, Bytes) -> Void) {
    guard s.count >= 2 else { return }
    var pos = Int(s.u16(0))
    while s.valid(pos, 4) {
        let tag = s.u16(pos)
        if tag == 0 { return }
        var length = Int(s.u16(pos + 2))
        if tag == 0x060e {
            length = 16             // a 16-byte label with no length of its own
        } else {
            pos += 4
            if tag == 0x8300 { continue }   // a container: its tags follow in line
        }
        guard s.valid(pos, length) else { return }
        visit(tag, s.sub(pos, length))
        pos += length
    }
}

struct RtmdValues {
    var iso: Int?
    var shutterS: Double?
    var aperture: Double?
    var shakeDegPerS: Double?
}

/// Sony's labels for S-Log3 (tag 0x3210, capture gamma) and S-Gamut3.Cine (tag 0x3219, colour primaries). On the 360 real
/// clips that also had a sidecar, these two came with `s-log3-cine` and `s-gamut3-cine` there, every time.
private let sLog3Label: [UInt8] = [0x06, 0x0e, 0x2b, 0x34, 0x04, 0x01, 0x01, 0x06, 0x0e, 0x06, 0x04, 0x01, 0x01, 0x01, 0x06, 0x05]
private let sGamut3CineLabel: [UInt8] = [0x06, 0x0e, 0x2b, 0x34, 0x04, 0x01, 0x01, 0x06, 0x0e, 0x06, 0x04, 0x01, 0x01, 0x03, 0x01, 0x05]
private func isLabel(_ b: Bytes, _ label: [UInt8]) -> Bool { b.count == 16 && (0..<16).allSatisfy { b.u8($0) == label[$0] } }

private func float32(_ b: Bytes) -> Float? {
    guard b.count == 4 else { return nil }
    return Float(bitPattern: b.u32(0))
}

/// The angular rate along one short run. The run's own mean goes, so a steady pan doesn't read as shake, and neither does
/// the gyro's bias.
private struct Jitter {
    private var sum = 0.0
    private var count = 0
    private var x: [Float] = [], y: [Float] = [], z: [Float] = []
    private var scale: Float = 0

    mutating func add(_ b: Bytes, scale newScale: Float) {
        guard b.count > 8, b.u32(4) == 6, x.count < rtmdMaxReadings else { return }
        scale = newScale
        let n = min(Int(b.u32(0)), (b.count - 8) / 6, rtmdMaxReadings - x.count)
        guard n > 0 else { return }
        for i in 0..<n {
            x.append(Float(Int16(bitPattern: b.u16(8 + i * 6))))
            y.append(Float(Int16(bitPattern: b.u16(10 + i * 6))))
            z.append(Float(Int16(bitPattern: b.u16(12 + i * 6))))
        }
    }

    mutating func endRun() {
        defer {
            x.removeAll(keepingCapacity: true)
            y.removeAll(keepingCapacity: true)
            z.removeAll(keepingCapacity: true)
        }
        let n = x.count
        guard n >= 16, scale > 0 else { return }
        func spread(_ a: [Float]) -> Double {
            let mean = a.reduce(0, +) / Float(n)
            return a.reduce(0.0) { $0 + Double(($1 - mean) * ($1 - mean)) }
        }
        sum += (spread(x) + spread(y) + spread(z)) / Double(scale * scale)
        count += n
    }

    var degPerS: Double? { count > 0 ? (sum / Double(count)).squareRoot() : nil }
}

/// The curve and gamut the track names, from a small read at the start of one sample. Nil when it names no curve.
func rtmdColor(_ plan: RtmdPlan, file: MediaFile) -> (sLog3: Bool, cine: Bool)? {
    guard let w = plan.windows.first, let data = try? file.read(at: w.offset, count: min(w.sizes[0], 4096)) else { return nil }
    var curve: Bool?, cine = false
    walkRtmd(data.bytes) { tag, b in
        if tag == 0x3210, b.count == 16 { curve = isLabel(b, sLog3Label) }
        if tag == 0x3219, b.count == 16 { cine = isLabel(b, sGamut3CineLabel) }
    }
    return curve.map { ($0, cine) }
}

/// Reads the planned runs and pulls out the values. Anything missing or absurd stays nil.
func readRtmd(_ plan: RtmdPlan, file: MediaFile) -> RtmdValues {
    var v = RtmdValues()
    var jitter = Jitter()
    for (index, w) in plan.windows.enumerated() {
        let total = w.sizes.reduce(0, +)
        guard let data = try? file.read(at: w.offset, count: total), data.count == total else { continue }
        var at = 0
        for size in w.sizes {
            let sample = data.bytes.sub(at, size)
            at += size
            var gyro: Bytes?
            var scale: Float = 0
            walkRtmd(sample) { tag, b in
                switch tag {
                case 0xe43b: gyro = b
                case 0xe439: scale = float32(b) ?? 0
                default: break
                }
                // The exposure at the clip's middle stands for the clip.
                guard index == plan.windows.count / 2 else { return }
                switch tag {
                case 0x8000 where b.count == 2 && v.aperture == nil:
                    let f = pow(2.0, 8 - Double(b.u16(0)) / 8192)
                    if f >= 0.5, f <= 128 { v.aperture = (f * 100).rounded() / 100 }
                case 0x8109 where b.count == 8 && v.shutterS == nil:
                    let n = b.u32(0), d = b.u32(4)
                    if n > 0, d > 0, Double(n) / Double(d) <= 3600 { v.shutterS = Double(n) / Double(d) }
                case 0xe301 where b.count == 4:
                    let iso = Int(b.u32(0))
                    if iso > 0, iso <= 10_000_000 { v.iso = iso }
                case 0x810b where b.count == 2 && v.iso == nil:
                    let iso = Int(b.u16(0))
                    if iso > 0 { v.iso = iso }
                default: break
                }
            }
            if let gyro, scale > 0.1, scale < 1e6 { jitter.add(gyro, scale: scale) }
        }
        jitter.endRun()
    }
    v.shakeDegPerS = jitter.degPerS
    return v
}
