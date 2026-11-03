import Foundation

// Focus score, computed on native-resolution luma tiles.
//
// For each 64 px tile, E is the mean squared first difference and L the mean squared second
// difference. On a Gaussian-blurred edge sqrt(L / E) comes to about 1 / (sqrt(2) * sigma), so the
// ratio estimates edge width directly, and gain and offset cancel, so dark and flat log frames are
// not marked down. What makes it hold on real rushes:
//  - Noise does not vanish with defocus and alone reads as very sharp, so it is measured from the
//    frame. Sensor noise depends on brightness, so there is one floor per brightness band, from
//    that band's quietest tiles. A band that is all fine texture would look like loud noise and
//    hide the very detail being measured, so every floor is capped at 1.5 times the lower quartile
//    of the band floors, ignoring bands crushed to black.
//  - Rounding is a noise of its own, since slow ramps dither between codes. Its variance is known
//    from the source bit depth, so it sets a minimum floor.
//  - The floor comes off L only, with E as it stands below. A tile barely above its noise therefore
//    tends to zero rather than to a wild ratio.
//  - Grain on a soft ramp still passes all of that: the ramp supplies E and the grain supplies L.
//    Noise spreads its energy over every pixel while an edge concentrates it on a few, so a tile
//    only counts when L clearly exceeds what a low quantile of its |Laplacian| predicts. This only
//    decides which tiles count. Subtracting it instead overcorrects grainy sharp frames, and then
//    blur makes the score rise.
//  - The score is the mean of the top 5% of the tiles that count, so a sharp subject on a soft
//    background scores as sharp.
// White noise gives sqrt(3), the top of the scale, hence the division by 1.73.

private let tileSize = 64
private let minTileStd = 6.0     // 10-bit codes, about one 8-bit level
private let structureOverNoise = 4.0
private let topFraction = 0.05
private let scaleTop = 1.73
private let brightnessBands = 12
private let minTilesPerBand = 12
private let floorCap = 1.5
private let noiseQuantile = 0.35
private let noiseQuantileOfGaussian = 0.4538   // |x| / sigma at that quantile
private let sparseOverGrain = 2.0

func sharpnessScore(_ f: FrameView, sourceBits: Int?) -> Double? {
    sharpness(y: f.y, stride: f.yStride, width: f.width, height: f.height, sourceBits: sourceBits)
}

private func median(_ v: [Double]) -> Double {
    let s = v.sorted()
    return s.isEmpty ? 0 : s[s.count / 2]
}

/// Edge and curve floors for each brightness band, taken from each band's quietest tiles.
private func noiseFloors(edge: [Double], curve: [Double], band: [Int], minEdge: Double, minCurve: Double)
    -> (edge: [Double], curve: [Double]) {
    func quiet(_ tiles: [Int]) -> (Double, Double) {
        let order = tiles.sorted { edge[$0] < edge[$1] }
        let q = order.prefix(max(1, tiles.count / 20))
        return (median(q.map { edge[$0] }), median(q.map { curve[$0] }))
    }
    func lowerQuartile(_ v: [Double], above: Double) -> Double {
        let live = v.filter { $0 > above }.sorted()
        return live.isEmpty ? v.max() ?? 0 : live[live.count / 4]
    }
    var members = [[Int]](repeating: [], count: brightnessBands)
    for i in 0..<band.count { members[band[i]].append(i) }
    var fe = [Double?](repeating: nil, count: brightnessBands), fl = fe
    for b in 0..<brightnessBands where members[b].count >= minTilesPerBand {
        (fe[b], fl[b]) = quiet(members[b])
    }
    let filled = (0..<brightnessBands).filter { fe[$0] != nil }
    if filled.isEmpty {
        let (e, l) = quiet(Array(0..<band.count))
        return ([Double](repeating: e, count: brightnessBands), [Double](repeating: l, count: brightnessBands))
    }
    let capEdge = floorCap * lowerQuartile(filled.map { fe[$0]! }, above: minEdge / 2)
    let capCurve = floorCap * lowerQuartile(filled.map { fl[$0]! }, above: minCurve / 2)
    var outE = [Double](repeating: 0, count: brightnessBands), outL = outE
    for b in 0..<brightnessBands {
        let near = filled.min { abs($0 - b) < abs($1 - b) }!
        outE[b] = min(fe[near]!, capEdge)
        outL[b] = min(fl[near]!, capCurve)
    }
    return (outE, outL)
}

/// The noise quantile of |Laplacian| over one tile, sampled on every other pixel and row.
private func tileLaplacianQuantile(_ top: UnsafePointer<UInt16>, stride: Int, histogram: UnsafeMutablePointer<UInt16>) -> Double {
    let bins = 2048
    histogram.update(repeating: 0, count: bins)
    var py = 0
    while py < tileSize {
        let c = top + py * stride
        let up = c - stride, down = c + stride
        var x = 0
        while x < tileSize {
            let m = Int32(c[x] >> 6)
            let lx = Int32(c[x + 1] >> 6) &+ Int32(c[x - 1] >> 6) &- 2 &* m
            let ly = Int32(up[x] >> 6) &+ Int32(down[x] >> 6) &- 2 &* m
            histogram[min(bins - 1, Int(abs(lx)))] &+= 1
            histogram[min(bins - 1, Int(abs(ly)))] &+= 1
            x += 2
        }
        py += 2
    }
    let samples = (tileSize / 2) * (tileSize / 2) * 2
    let target = Int(Double(samples) * noiseQuantile)
    var seen = 0
    for v in 0..<bins {
        seen += Int(histogram[v])
        if seen > target { return Double(v) }
    }
    return Double(bins - 1)
}

func sharpness(y: UnsafePointer<UInt16>, stride: Int, width: Int, height: Int, sourceBits: Int?) -> Double? {
    let cols = (width - 2) / tileSize, rows = (height - 2) / tileSize
    guard cols >= 2, rows >= 2 else { return nil }
    let x0 = (width - cols * tileSize) / 2, y0 = (height - rows * tileSize) / 2
    let tiles = cols * rows
    var edge = [Double](repeating: 0, count: tiles)
    var curve = edge, variance = edge
    var band = [Int](repeating: 0, count: tiles)

    let perTile = Double(tileSize * tileSize)
    for ty in 0..<rows {
        var acc = [(e: UInt64, l: UInt64, s: UInt64, q: UInt64)](repeating: (0, 0, 0, 0), count: cols)
        for py in 0..<tileSize {
            let c = y + (y0 + ty * tileSize + py) * stride
            let up = c - stride, down = c + stride
            for tx in 0..<cols {
                let start = x0 + tx * tileSize
                var e: UInt32 = 0, l: UInt32 = 0, s: UInt32 = 0, q: UInt32 = 0
                for x in start..<(start + tileSize) {
                    let m = Int32(c[x] >> 6)
                    let r = Int32(c[x + 1] >> 6), le = Int32(c[x - 1] >> 6)
                    let u = Int32(up[x] >> 6), d = Int32(down[x] >> 6)
                    let dx = r &- m, dy = d &- m
                    let lx = r &+ le &- 2 &* m, ly = u &+ d &- 2 &* m
                    e &+= UInt32(truncatingIfNeeded: dx &* dx &+ dy &* dy)
                    l &+= UInt32(truncatingIfNeeded: lx &* lx &+ ly &* ly)
                    s &+= UInt32(truncatingIfNeeded: m)
                    q &+= UInt32(truncatingIfNeeded: m &* m)
                }
                acc[tx].e &+= UInt64(e)
                acc[tx].l &+= UInt64(l)
                acc[tx].s &+= UInt64(s)
                acc[tx].q &+= UInt64(q)
            }
        }
        for tx in 0..<cols {
            let i = ty * cols + tx
            edge[i] = Double(acc[tx].e) / (2 * perTile)
            curve[i] = Double(acc[tx].l) / (2 * perTile)
            let mean = Double(acc[tx].s) / perTile
            variance[i] = max(0, Double(acc[tx].q) / perTile - mean * mean)
            band[i] = min(brightnessBands - 1, Int(mean / 1024 * Double(brightnessBands)))
        }
    }

    let structured = (0..<tiles).filter { variance[$0] > minTileStd * minTileStd }
    guard structured.count >= 4 else { return nil }   // A black or flat frame says nothing about focus.

    // One 8-bit level is four 10-bit codes. Rounding adds q^2/6 to E and q^2/2 to L.
    let step = (sourceBits ?? 10) <= 8 ? 4.0 : 1.0
    let minEdge = step * step / 6, minCurve = step * step / 2
    let (floorE, floorL) = noiseFloors(edge: edge, curve: curve, band: band, minEdge: minEdge, minCurve: minCurve)
    func noiseE(_ i: Int) -> Double { max(floorE[band[i]], minEdge) }

    let strong = structured.filter { edge[$0] > structureOverNoise * noiseE($0) }
    let histogram = UnsafeMutablePointer<UInt16>.allocate(capacity: 2048)
    defer { histogram.deallocate() }
    let sparse = strong.filter { i in
        let top = y + (y0 + (i / cols) * tileSize) * stride + x0 + (i % cols) * tileSize
        let sigma = tileLaplacianQuantile(top, stride: stride, histogram: histogram) / noiseQuantileOfGaussian
        return curve[i] > sparseOverGrain * sigma * sigma
    }
    let chosen = sparse.count >= 8 ? sparse : (strong.count >= 8 ? strong : structured)
    var ratios = chosen.map { i -> Double in
        (max(curve[i] - max(floorL[band[i]], minCurve), 0) / max(edge[i], noiseE(i))).squareRoot()
    }
    ratios.sort(by: >)
    let n = max(4, Int(Double(ratios.count) * topFraction))
    let top = ratios.prefix(n).reduce(0, +) / Double(min(n, ratios.count))
    return min(1, top / scaleTop)
}

/// Native-resolution Gaussian blur of the luma plane, used only by the proof.
func gaussianLuma(_ f: FrameView, sigma: Double) -> [UInt16] {
    let w = f.width, h = f.height
    var plane = [Float](repeating: 0, count: w * h)
    for y in 0..<h {
        let row = f.y + y * f.yStride
        for x in 0..<w { plane[y * w + x] = Float(row[x] >> 6) }
    }
    let radius = max(1, Int(sigma * 4 + 0.5))
    var kernel = (-radius...radius).map { Float(exp(-Double($0 * $0) / (2 * sigma * sigma))) }
    let total = kernel.reduce(0, +)
    kernel = kernel.map { $0 / total }
    var a = [Float](repeating: 0, count: w * h)
    for y in 0..<h {
        for x in 0..<w {
            var s: Float = 0
            for k in -radius...radius { s += kernel[k + radius] * plane[y * w + min(w - 1, max(0, x + k))] }
            a[y * w + x] = s
        }
    }
    var out = [UInt16](repeating: 0, count: w * h)
    for x in 0..<w {
        for y in 0..<h {
            var s: Float = 0
            for k in -radius...radius { s += kernel[k + radius] * a[min(h - 1, max(0, y + k)) * w + x] }
            out[y * w + x] = UInt16(max(0, min(1023, s.rounded()))) << 6
        }
    }
    return out
}
