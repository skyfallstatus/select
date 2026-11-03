import Accelerate
import CoreVideo
import Foundation
import simd

// Dominant colours in Oklab, a space built so that distances match what people see.
// Log footage is flat by design, so it goes back to linear light through its own curve and gamut first.
// Without that step almost every S-Log clip reads as a washed-out neutral.

struct ColorResult {
    var hue: Double?
    var chroma = 0.0
    var light = 0.0
    var name = "neutral"
    var palette: [String] = []
}

/// 8-bit RGB code to linear light, one table per curve.
private let displayToLinear: [Float] = (0..<256).map { pow(Float($0) / 255, 2.2) }

/// S-Log3 code value, in the video-range image VideoToolbox gives, to scene linear with 18% grey at 0.18, then through a
/// gentle display curve so that highlights land where they would on a monitor.
private let sLog3ToLinear: [Float] = (0..<256).map { code in
    let cv = 64 + 876 * Double(code) / 255
    let scene = cv >= 171.2102946929
        ? pow(10, (cv - 420) / 261.5) * 0.19 - 0.01
        : (cv - 95) * 0.01125 / (171.2102946929 - 95)
    return Float(max(0, scene))
}

private func xyz(_ x: Float, _ y: Float) -> SIMD3<Float> { SIMD3(x / y, 1, (1 - x - y) / y) }

private func rgbToXYZ(_ r: (Float, Float), _ g: (Float, Float), _ b: (Float, Float)) -> simd_float3x3 {
    let primaries = simd_float3x3(xyz(r.0, r.1), xyz(g.0, g.1), xyz(b.0, b.1))
    let scale = primaries.inverse * xyz(0.3127, 0.3290)
    return simd_float3x3(primaries.columns.0 * scale.x, primaries.columns.1 * scale.y, primaries.columns.2 * scale.z)
}

/// S-Gamut3.Cine to Rec.709, from the published primaries. Both are D65.
private let sGamut3CineTo709: simd_float3x3 = {
    let cine = rgbToXYZ((0.766, 0.275), (0.225, 0.800), (0.089, -0.087))
    let rec709 = rgbToXYZ((0.64, 0.33), (0.30, 0.60), (0.15, 0.06))
    return rec709.inverse * cine
}()

@inline(__always) private func filmic(_ e: Float) -> Float { e * (1 + e / 16) / (1 + e) }

private let displayEncode: [Float] = (0...1023).map { Float(pow(Double($0) / 1023, 1 / 2.2)) }

/// A clip's S-Log3 values, 0 to 1 in the video range, as they'd look on a monitor. For thumbnails.
@inline(__always) func gradeLog(_ c: SIMD3<Float>) -> SIMD3<Float> {
    func scene(_ v: Float) -> Float { sLog3ToLinear[max(0, min(255, Int(v * 255)))] }
    let lin = sGamut3CineTo709 * SIMD3(scene(c.x), scene(c.y), scene(c.z))
    func show(_ v: Float) -> Float { displayEncode[Int(max(0, min(1, filmic(max(0, v) * 2.2))) * 1023)] }
    return SIMD3(show(lin.x), show(lin.y), show(lin.z))
}

/// Makes a small BGRA log image look like the shot, in place, so Vision sees what a person would. Per channel, no gamut step:
/// Vision needs contrast, not accurate colour, and this costs a fraction of a millisecond.
private let logDisplayTable: [UInt8] = (0..<256).map { code in
    UInt8(max(0, min(255, pow(filmic(sLog3ToLinear[code] * 2.2), 1 / 2.2) * 255)))
}

func gradeForVision(_ image: CVPixelBuffer) {
    guard CVPixelBufferLockBaseAddress(image, []) == 0 else { return }
    defer { CVPixelBufferUnlockBaseAddress(image, []) }
    guard let base = CVPixelBufferGetBaseAddress(image) else { return }
    var buffer = vImage_Buffer(data: base, height: UInt(CVPixelBufferGetHeight(image)), width: UInt(CVPixelBufferGetWidth(image)),
                               rowBytes: CVPixelBufferGetBytesPerRow(image))
    // vImage names its tables for ARGB, but they apply to bytes in memory order, which here is B, G, R, A.
    logDisplayTable.withUnsafeBufferPointer { t in
        _ = vImageTableLookUp_ARGB8888(&buffer, &buffer, t.baseAddress, t.baseAddress, t.baseAddress, nil, vImage_Flags(kvImageNoFlags))
    }
}

/// Linear Rec.709 to Oklab.
@inline(__always) func oklab(_ c: SIMD3<Float>) -> SIMD3<Float> {
    let l = 0.4122215 * c.x + 0.5363325 * c.y + 0.0514460 * c.z
    let m = 0.2119035 * c.x + 0.6806995 * c.y + 0.1073970 * c.z
    let s = 0.0883025 * c.x + 0.2817188 * c.y + 0.6299787 * c.z
    let a = cbrtf(max(l, 0)), b = cbrtf(max(m, 0)), d = cbrtf(max(s, 0))
    return SIMD3(0.2104543 * a + 0.7936178 * b - 0.0040720 * d,
                 1.9779985 * a - 2.4285922 * b + 0.4505937 * d,
                 0.0259040 * a + 0.7827718 * b - 0.8086758 * d)
}

private func hex(_ lab: SIMD3<Float>) -> String {
    let l = lab.x + 0.3963378 * lab.y + 0.2158038 * lab.z
    let m = lab.x - 0.1055613 * lab.y - 0.0638542 * lab.z
    let s = lab.x - 0.0894842 * lab.y - 1.2914855 * lab.z
    let (a, b, c) = (l * l * l, m * m * m, s * s * s)
    let linear = SIMD3<Float>(4.0767417 * a - 3.3077116 * b + 0.2309699 * c,
                              -1.2684380 * a + 2.6097574 * b - 0.3413194 * c,
                              -0.0041961 * a - 0.7034186 * b + 1.7076147 * c)
    func code(_ v: Float) -> Int {
        let x = max(0, min(1, v))
        let e = x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
        return Int((e * 255).rounded())
    }
    return String(format: "#%02x%02x%02x", code(linear.x), code(linear.y), code(linear.z))
}

/// Hue names in Oklab degrees.
func colorName(hue: Double) -> String {
    switch hue {
    case 0..<20: return "pink"
    case 20..<45: return "red"
    case 45..<80: return "orange"
    case 80..<115: return "yellow"
    case 115..<165: return "green"
    case 165..<220: return "teal"
    case 220..<285: return "blue"
    case 285..<330: return "purple"
    default: return "pink"
    }
}

/// Collects pixels from each moment, then settles on the colours.
struct ColorSampler {
    private var pixels: [SIMD3<Float>] = []
    private let perMoment = 3200

    mutating func add(_ image: CVPixelBuffer, isLog: Bool) {
        guard CVPixelBufferLockBaseAddress(image, .readOnly) == 0 else { return }
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(image) else { return }
        let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image), row = CVPixelBufferGetBytesPerRow(image)
        guard width > 0, height > 0 else { return }
        let step = max(1, Int((Double(width * height) / Double(perMoment)).squareRoot()))
        let p = base.assumingMemoryBound(to: UInt8.self)
        let table = isLog ? sLog3ToLinear : displayToLinear
        table.withUnsafeBufferPointer { t in
            var y = step / 2
            while y < height {
                let line = p + y * row
                var x = step / 2
                while x < width {
                    let px = line + x * 4       // BGRA
                    var c = SIMD3(t[Int(px[2])], t[Int(px[1])], t[Int(px[0])])
                    if isLog {
                        c = sGamut3CineTo709 * c
                        c = SIMD3(filmic(max(0, c.x) * 2.2), filmic(max(0, c.y) * 2.2), filmic(max(0, c.z) * 2.2))
                    }
                    pixels.append(oklab(c))
                    x += step
                }
                y += step
            }
        }
    }

    /// k-means in Oklab, seeded across lightness so the result is the same on every run.
    private func clusters(_ k: Int) -> [(center: SIMD3<Float>, share: Float)] {
        let order = pixels.indices.sorted { pixels[$0].x < pixels[$1].x }
        var centers = (0..<k).map { pixels[order[(2 * $0 + 1) * order.count / (2 * k)]] }
        var totals = [SIMD3<Float>](repeating: .zero, count: k)
        var counts = [Int](repeating: 0, count: k)
        for _ in 0..<6 {
            totals = totals.map { _ in .zero }
            counts = counts.map { _ in 0 }
            for p in pixels {
                var best = 0
                var bestDistance = Float.infinity
                for c in 0..<k {
                    let d = simd_distance_squared(p, centers[c])
                    if d < bestDistance {
                        bestDistance = d
                        best = c
                    }
                }
                totals[best] += p
                counts[best] += 1
            }
            for c in 0..<k where counts[c] > 0 { centers[c] = totals[c] / Float(counts[c]) }
        }
        return (0..<k).filter { counts[$0] > 0 }.map { (centers[$0], Float(counts[$0]) / Float(pixels.count)) }
    }

    mutating func merge(_ other: ColorSampler) { pixels += other.pixels }

    /// The average colour of everything sampled, in Oklab.
    var mean: (a: Float, b: Float)? {
        guard !pixels.isEmpty else { return nil }
        var total = SIMD3<Float>.zero
        for p in pixels { total += p }
        return (total.y / Float(pixels.count), total.z / Float(pixels.count))
    }

    func finish() -> ColorResult? {
        guard pixels.count >= 32 else { return nil }
        var out = ColorResult()
        // A hue counts by how much of the frame wears it and how clearly. Black and white have no say.
        var bins = [Float](repeating: 0, count: 72)
        var chromatic: Float = 0
        for p in pixels where p.x > 0.12 && p.x < 0.97 {
            let c = (p.y * p.y + p.z * p.z).squareRoot()
            guard c >= chromaFloor else { continue }
            let deg = atan2(p.z, p.y) * 180 / .pi
            bins[Int((deg + 360).truncatingRemainder(dividingBy: 360) / 5) % 72] += min(c, 0.12)
            chromatic += 1
        }
        let share = chromatic / Float(pixels.count)
        var smooth = [Float](repeating: 0, count: 72)
        for i in 0..<72 {
            for o in -2...2 { smooth[i] += bins[(i + o + 72) % 72] }
        }
        let peak = smooth.indices.max { smooth[$0] < smooth[$1] } ?? 0
        if share >= neutralShare {
            let degrees = Double(peak) * 5 + 2.5
            var sumC: Float = 0, sumL: Float = 0, n: Float = 0
            var a: Float = 0, b: Float = 0
            for p in pixels where p.x > 0.12 && p.x < 0.97 {
                let c = (p.y * p.y + p.z * p.z).squareRoot()
                guard c >= chromaFloor else { continue }
                var d = Double(atan2(p.z, p.y)) * 180 / .pi - degrees
                d = (d + 540).truncatingRemainder(dividingBy: 360) - 180
                guard abs(d) <= 20 else { continue }
                sumC += c
                sumL += p.x
                a += p.y
                b += p.z
                n += 1
            }
            if n > 0 {
                let hue = (Double(atan2(b, a)) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
                let chroma = min(1, Double(sumC / n) / 0.3)
                // A pale wall has a warm hue and nobody calls it yellow. Cream, beige and stone stay neutral.
                if chroma >= 0.16, !(hue >= 70 && hue < 115 && chroma < 0.2) {
                    out.hue = hue
                    out.chroma = chroma
                    out.light = Double(sumL / n)
                    out.name = colorName(hue: hue)
                }
            }
        }
        let parts = clusters(5).sorted {
            let ca = ($0.center.y * $0.center.y + $0.center.z * $0.center.z).squareRoot()
            let cb = ($1.center.y * $1.center.y + $1.center.z * $1.center.z).squareRoot()
            return $0.share * (0.3 + min(ca, 0.1) * 7) > $1.share * (0.3 + min(cb, 0.1) * 7)
        }
        if out.hue == nil {
            out.light = Double(pixels.reduce(0) { $0 + $1.x } / Float(pixels.count))
            let c = pixels.reduce(Float(0)) { $0 + ($1.y * $1.y + $1.z * $1.z).squareRoot() } / Float(pixels.count)
            out.chroma = min(1, Double(c) / 0.3)
        }
        out.palette = parts.map { hex($0.center) }
        return out
    }
}

private let chromaFloor: Float = 0.045
private let neutralShare: Float = 0.12
