import CoreGraphics
import Foundation
import ImageIO

struct Metrics {
    var luma = 0.0
    var contrast = 0.0
    var clipHigh = 0.0
    var clipLow = 0.0
    var saturation = 0.0
    var warmth = 0.0
    var dhash = ""
    var sharpness: Double?
    var thumbWritten = false
    var thumbMs = 0.0
}

private let limitedBlack = 64.0
private let limitedRange = 876.0

/// Tonal statistics from point samples, so a small blown highlight still counts.
private func tone(_ f: FrameView, into m: inout Metrics) {
    let step = max(1, max(f.width, f.height) / 960)
    var hist = [UInt32](repeating: 0, count: 1024)
    hist.withUnsafeMutableBufferPointer { h in
        var y = 0
        while y < f.height {
            let row = f.y + y * f.yStride
            var x = 0
            while x < f.width {
                h[Int(row[x] >> 6)] &+= 1
                x += step
            }
            y += step
        }
    }
    var n = 0.0, sum = 0.0, sq = 0.0, hi = 0.0, lo = 0.0
    // Same cut points as the baseline, 5 and 250 on an 8-bit scale.
    let lowCut = 5.0 / 255, highCut = 250.0 / 255
    for code in 0..<1024 where hist[code] > 0 {
        let c = Double(hist[code])
        let v = min(1, max(0, (Double(code) - limitedBlack) / limitedRange))
        n += c
        sum += c * v
        sq += c * v * v
        if v <= lowCut { lo += c }
        if v >= highCut { hi += c }
    }
    guard n > 0 else { return }
    let mean = sum / n
    m.luma = mean
    m.contrast = min(1, max(0, sq / n - mean * mean).squareRoot() / 0.5)
    m.clipHigh = hi / n * 100
    m.clipLow = lo / n * 100
}

private func colour(_ f: FrameView, into m: inout Metrics) {
    let cw = f.width / 2, ch = f.height / 2
    let step = max(1, max(cw, ch) / 480)
    var n = 0, cb = 0, cr = 0
    var magnitude: Float = 0
    var y = 0
    while y < ch {
        let row = f.uv + y * f.uvStride
        var x = 0
        while x < cw {
            let b = Int(row[x * 2] >> 6) - 512, r = Int(row[x * 2 + 1] >> 6) - 512
            cb += b
            cr += r
            let fb = Float(b), fr = Float(r)
            magnitude += (fb * fb + fr * fr).squareRoot()
            n += 1
            x += step
        }
        y += step
    }
    guard n > 0 else { return }
    let scale = 1 / (896.0 * Double(n))
    m.saturation = min(1, Double(magnitude) * scale * 2)
    let meanB = Double(cb) * scale, meanR = Double(cr) * scale
    let red = m.luma + 1.5748 * meanR, blue = m.luma + 1.8556 * meanB
    m.warmth = max(-1, min(1, (red - blue) / max(red + blue, 0.02)))
}

/// Box-filtered display-orientation proxy, 240 px on the long side, 10-bit YCbCr.
struct Proxy {
    var width = 0
    var height = 0
    var y: [Float] = []
    var cb: [Float] = []
    var cr: [Float] = []
}

private func cellEdges(_ cells: Int, _ total: Int) -> [Int] { (0...cells).map { $0 * total / cells } }

private func makeProxy(_ f: FrameView, rotation: Int) -> Proxy {
    let long = 240
    let scale = Double(long) / Double(max(f.width, f.height))
    let pw = max(1, Int((Double(f.width) * scale).rounded())), ph = max(1, Int((Double(f.height) * scale).rounded()))
    var ys = [Float](repeating: 0, count: pw * ph)
    var cbs = ys, crs = ys
    let xe = cellEdges(pw, f.width), ye = cellEdges(ph, f.height)
    let cxe = cellEdges(pw, f.width / 2), cye = cellEdges(ph, f.height / 2)
    for py in 0..<ph {
        var y0 = ye[py]
        let y1 = max(y0 + 1, ye[py + 1])
        // Every other row is enough for a thumbnail and halves the cost.
        let rowStep = y1 - y0 >= 4 ? 2 : 1
        var rows = 0
        var acc = [UInt32](repeating: 0, count: pw)
        while y0 < y1 {
            let row = f.y + y0 * f.yStride
            for px in 0..<pw {
                var s: UInt32 = 0
                for x in xe[px]..<max(xe[px] + 1, xe[px + 1]) { s &+= UInt32(row[x] >> 6) }
                acc[px] &+= s
            }
            rows += 1
            y0 += rowStep
        }
        for px in 0..<pw {
            ys[py * pw + px] = Float(acc[px]) / Float(rows * max(1, xe[px + 1] - xe[px]))
        }
        let cy = min(cye[py], f.height / 2 - 1)
        let row = f.uv + cy * f.uvStride
        for px in 0..<pw {
            var b: UInt32 = 0, r: UInt32 = 0
            let x0 = cxe[px], x1 = max(x0 + 1, cxe[px + 1])
            for x in x0..<x1 {
                b &+= UInt32(row[x * 2] >> 6)
                r &+= UInt32(row[x * 2 + 1] >> 6)
            }
            cbs[py * pw + px] = Float(b) / Float(x1 - x0)
            crs[py * pw + px] = Float(r) / Float(x1 - x0)
        }
    }
    guard rotation != 0 else { return Proxy(width: pw, height: ph, y: ys, cb: cbs, cr: crs) }

    let ow = rotation == 180 ? pw : ph, oh = rotation == 180 ? ph : pw
    var oy = [Float](repeating: 0, count: ow * oh)
    var ob = oy, or = oy
    for dy in 0..<oh {
        for dx in 0..<ow {
            let sx: Int, sy: Int
            switch rotation {
            case 90: (sx, sy) = (dy, ph - 1 - dx)
            case 180: (sx, sy) = (pw - 1 - dx, ph - 1 - dy)
            default: (sx, sy) = (pw - 1 - dy, dx)
            }
            let s = sy * pw + sx, d = dy * ow + dx
            oy[d] = ys[s]
            ob[d] = cbs[s]
            or[d] = crs[s]
        }
    }
    return Proxy(width: ow, height: oh, y: oy, cb: ob, cr: or)
}

/// 64-bit difference hash on a 9 by 8 grid of the display-orientation image.
private func differenceHash(_ p: Proxy) -> String {
    let gw = 9, gh = 8
    var grid = [Float](repeating: 0, count: gw * gh)
    let xe = cellEdges(gw, p.width), ye = cellEdges(gh, p.height)
    for gy in 0..<gh {
        for gx in 0..<gw {
            var s: Float = 0
            var n = 0
            for y in ye[gy]..<max(ye[gy] + 1, ye[gy + 1]) where y < p.height {
                for x in xe[gx]..<max(xe[gx] + 1, xe[gx + 1]) where x < p.width {
                    s += p.y[y * p.width + x]
                    n += 1
                }
            }
            grid[gy * gw + gx] = n > 0 ? s / Float(n) : 0
        }
    }
    var bits: UInt64 = 0
    for gy in 0..<gh {
        for gx in 0..<(gw - 1) {
            bits = bits << 1 | (grid[gy * gw + gx] < grid[gy * gw + gx + 1] ? 1 : 0)
        }
    }
    return String(format: "%016llx", bits)
}

private func writeThumbnail(_ p: Proxy, to path: String) -> Bool {
    var rgb = [UInt8](repeating: 255, count: p.width * p.height * 4)
    for i in 0..<(p.width * p.height) {
        let y = (p.y[i] - 64) / 876, b = (p.cb[i] - 512) / 896, r = (p.cr[i] - 512) / 896
        let cr = y + 1.5748 * r, cg = y - 0.1873 * b - 0.4681 * r, cb = y + 1.8556 * b
        rgb[i * 4] = UInt8(max(0, min(255, cr * 255)))
        rgb[i * 4 + 1] = UInt8(max(0, min(255, cg * 255)))
        rgb[i * 4 + 2] = UInt8(max(0, min(255, cb * 255)))
    }
    return rgb.withUnsafeMutableBytes { raw -> Bool in
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: raw.baseAddress, width: p.width, height: p.height, bitsPerComponent: 8,
                                  bytesPerRow: p.width * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
              let image = ctx.makeImage(),
              let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.jpeg" as CFString, 1, nil)
        else { return false }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
        return CGImageDestinationFinalize(dest)
    }
}

func analyze(_ f: FrameView, rotation: Int, sourceBits: Int?, thumbPath: String?) -> Metrics? {
    guard f.width >= 8, f.height >= 8 else { return nil }
    var m = Metrics()
    tone(f, into: &m)
    colour(f, into: &m)
    m.sharpness = sharpnessScore(f, sourceBits: sourceBits)
    let proxy = makeProxy(f, rotation: rotation)
    m.dhash = differenceHash(proxy)
    if let thumbPath {
        let t0 = DispatchTime.now().uptimeNanoseconds
        m.thumbWritten = writeThumbnail(proxy, to: thumbPath)
        m.thumbMs = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
    }
    return m
}
