import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

// `strip`: frames evenly through one clip, side by side in one JPEG, for scrubbing a grid picture by hovering over it. Only
// sync samples are decoded, each on its own, so a frame costs one read and one decode whatever the GOP. The strip is cached
// under the cache folder by the clip's path, size and dates, so asking again costs a file check.
//
// It never takes the cache's lock and writes only in `strips/`, a new file at a time, so it's safe beside a scan of the same
// cache. The whole run has a deadline: past it the answer is an error and nothing is kept.

/// The frames a strip is made of, when nobody asks for another number.
let stripDefaultFrames = 14
/// Each frame's width in the strip. Frames are 16:9, so 384 gives 216 px tall.
let stripDefaultWidth = 384

/// Where a strip's parts go and what they're called. `stem` is shared by every strip of one version of one clip.
struct StripFiles {
    let dir: String
    let stem: String
    let frames: Int
    let width: Int
    var name: String { "\(stem)-\(frames)x\(width)" }
    var jpeg: String { dir + "/" + name + ".jpg" }
    var meta: String { dir + "/" + name + ".json" }
}

/// One hash of the clip's path and file details, so a clip that changed never gets an old strip. Upkeep at the end of a scan
/// works it out again from the index, to drop the strips of clips that changed or went.
func stripStem(jsonPath: String, key: FileKey) -> String {
    var h: UInt64 = 0xcbf2_9ce4_8423_2325
    for b in "\(jsonPath)|\(key.text)|\(schemaVersion)|strip".utf8 { h = (h ^ UInt64(b)) &* 0x0000_0100_0000_01b3 }
    return String(format: "%016llx", h)
}

/// One frame of the strip: where its sync sample is, and when.
private struct StripMoment {
    let offset: Int64
    let size: Int
    let time: Double
}

/// The last sync sample at or before `sample`, or the first one when none comes before it.
private func syncAtOrBefore(_ t: Track, _ sample: Int) -> Int {
    guard let stss = t.stss, stss.count >= 4 else { return sample }
    var lo = 0, hi = stss.count / 4 - 1
    if Int(stss.u32(0)) - 1 > sample { return Int(stss.u32(0)) - 1 }
    while lo < hi {
        let mid = (lo + hi + 1) / 2
        if Int(stss.u32(mid * 4)) - 1 <= sample { lo = mid } else { hi = mid - 1 }
    }
    return Int(stss.u32(lo * 4)) - 1
}

/// When a sample is decoded, in the track's timescale.
private func decodeTicks(_ t: Track, _ sample: Int) -> UInt64 {
    var ticks: UInt64 = 0
    var s = 0
    for i in 0..<(t.stts.count / 8) {
        let n = Int(t.stts.u32(i * 8)), d = UInt64(t.stts.u32(i * 8 + 4))
        if s + n > sample { return ticks + UInt64(sample - s) * d }
        ticks += UInt64(n) * d
        s += n
    }
    return ticks
}

/// A strip's pixels, BGRA, frames side by side, in one buffer allocated up front. Frames are written from several threads at
/// once, each to its own slot, so it's plain memory rather than a Swift array, which no two threads may write at once.
private final class Sprite {
    let frames: Int
    let width: Int
    let height: Int
    let count: Int
    let pixels: UnsafeMutablePointer<UInt32>
    init(frames: Int, width: Int, height: Int) {
        self.frames = frames
        self.width = width
        self.height = height
        count = frames * width * height
        pixels = .allocate(capacity: max(1, count))
        pixels.initialize(repeating: 0xFF00_0000, count: max(1, count))
    }
    deinit { pixels.deallocate() }
    var rowPixels: Int { frames * width }

    /// Copies one frame's image into slot `i`, cropped from the centre to the strip's shape, after rotation, the way the
    /// thumbnail is turned. `image` is in the clip's coded orientation and already scaled so the crop is `width` wide.
    func put(_ i: Int, from base: UnsafeRawPointer, rowBytes: Int, w pw: Int, h ph: Int, rotation: Int) {
        guard i >= 0, i < frames else { return }
        let turned = rotation == 90 || rotation == 270
        let dw = turned ? ph : pw, dh = turned ? pw : ph
        let x0 = max(0, (dw - width) / 2), y0 = max(0, (dh - height) / 2)
        for y in 0..<min(height, dh) {
            let dy = y + y0
            let line = pixels + (i * width + y * rowPixels)
            for x in 0..<min(width, dw) {
                let dx = x + x0
                let sx: Int, sy: Int
                switch rotation {
                case 90: (sx, sy) = (dy, ph - 1 - dx)
                case 180: (sx, sy) = (pw - 1 - dx, ph - 1 - dy)
                case 270: (sx, sy) = (pw - 1 - dy, dx)
                default: (sx, sy) = (dx, dy)
                }
                line[x] = base.load(fromByteOffset: sy * rowBytes + sx * 4, as: UInt32.self)
            }
        }
    }

    /// The same frame twice, when two slices of the clip share a sync sample.
    func copy(_ from: Int, to i: Int) {
        for y in 0..<height {
            (pixels + (i * width + y * rowPixels)).update(from: pixels + (from * width + y * rowPixels), count: width)
        }
    }

    /// Log footage graded as its thumbnail is, so the strip looks like the shot.
    func gradeLogFrames() {
        func byte(_ v: Float) -> UInt32 { UInt32(max(0, min(255, v * 255))) }
        for i in 0..<count {
            let p = pixels[i]
            let c = gradeLog(SIMD3(Float((p >> 16) & 255) / 255, Float((p >> 8) & 255) / 255, Float(p & 255) / 255))
            pixels[i] = 0xFF00_0000 | byte(c.x) << 16 | byte(c.y) << 8 | byte(c.z)
        }
    }

    func writeJPEG(to path: String) -> Bool {
        guard count > 0, let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: pixels, width: rowPixels, height: height, bitsPerComponent: 8,
                                  bytesPerRow: rowPixels * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
              let image = ctx.makeImage(),
              let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.jpeg" as CFString, 1, nil)
        else { return false }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        return CGImageDestinationFinalize(dest)
    }
}

enum StripError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self { case .message(let m): return m }
    }
}

private let noFrames = "This clip has no frames \(productName) can read."

/// The direct route: sync samples from the MP4 tables, decoded by VideoToolbox. Nil when the clip needs the slow route.
private func directStrip(path: String, frames n: Int, sprite: Sprite) -> [Double]? {
    guard let f = try? MediaFile(path: path), let m = try? loadMovie(f), let v = m.video, !m.fragmented, v.timescale > 0 else {
        return nil
    }
    let codedW = Int(v.stsdEntry.u16(24)), codedH = Int(v.stsdEntry.u16(26))
    guard codedW > 1, codedH > 1 else { return nil }
    let rotation = rotationOf(v.matrix)
    let side = readSidecar(clipPath: path) ?? m.outerMeta.flatMap(embeddedSidecar)
    let color = colorPlan(gamma: side?.gamma ?? transferGamma(v), primaries: side?.primaries,
                          rtmd: rtmdPlan(m).flatMap { rtmdColor($0, file: f) })

    // Every slice's sync sample, and each different one once.
    let total = v.sttsTotal()
    var samples: [Int] = []
    for i in 0..<n {
        let ticks = UInt64((Double(i) + 0.5) / Double(n) * Double(total))
        samples.append(syncAtOrBefore(v, v.sampleAt(mediaTime: ticks)))
    }
    var moments: [Int: StripMoment] = [:]
    for s in Set(samples) {
        guard let off = v.sampleOffset(s), v.sampleSize(s) > 0, v.sampleSize(s) < maxSampleBytes else { return nil }
        moments[s] = StripMoment(offset: off, size: v.sampleSize(s), time: Double(decodeTicks(v, s)) / Double(v.timescale))
    }

    // Scaled in the decoder so the centre crop, after rotation, is exactly the frame size.
    let turned = rotation == 90 || rotation == 270
    let dw = Double(turned ? codedH : codedW), dh = Double(turned ? codedW : codedH)
    let scale = max(Double(sprite.width) / dw, Double(sprite.height) / dh)
    let sw = max(sprite.width, Int((dw * scale).rounded(.up))), sh = max(sprite.height, Int((dh * scale).rounded(.up)))
    let (outW, outH) = turned ? (sh, sw) : (sw, sh)
    let atoms = decoderAtoms(v)

    let unique = Array(moments.keys).sorted()
    let pool = DecoderPool(capacity: 4)
    let lock = NSLock()
    var decoded = Set<Int>()
    var firstSlot: [Int: Int] = [:]
    for (i, s) in samples.enumerated() where firstSlot[s] == nil { firstSlot[s] = i }
    DispatchQueue.concurrentPerform(iterations: unique.count) { k in
        let s = unique[k]
        guard let mo = moments[s], let slot = firstSlot[s],
              let sample = try? f.read(at: mo.offset, count: mo.size), sample.count == mo.size else { return }
        let plan = VideoPlan(offset: mo.offset, size: mo.size, format: v.format, codedWidth: codedW, codedHeight: codedH, atoms: atoms)
        let result = pool.decodeScaled(plan, sample: sample, width: outW, height: outH) { image, _ -> Bool in
            guard CVPixelBufferLockBaseAddress(image, .readOnly) == 0 else { return false }
            defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
            guard let base = CVPixelBufferGetBaseAddress(image) else { return false }
            let w = CVPixelBufferGetWidth(image), h = CVPixelBufferGetHeight(image)
            guard w == outW, h == outH else { return false }
            // Slots never overlap, so each thread writes its own part of the sprite.
            sprite.put(slot, from: base, rowBytes: CVPixelBufferGetBytesPerRow(image), w: w, h: h, rotation: rotation)
            return true
        }
        if case .frame(true) = result {
            lock.lock()
            decoded.insert(s)
            lock.unlock()
        }
    }
    pool.closeAll()
    // A frame that didn't decode would leave a black hole in the strip, so then the slow route has a go.
    guard decoded.count == unique.count else { return nil }
    for (i, s) in samples.enumerated() where firstSlot[s] != i { sprite.copy(firstSlot[s]!, to: i) }
    if color.convert { sprite.gradeLogFrames() }
    return samples.map { (moments[$0]!.time * 1000).rounded() / 1000 }
}

/// The slow route, for MXF and anything VideoToolbox won't take: one ffmpeg per frame, a few at a time, each landing on the
/// keyframe at or before its time. `deadline` is in the clock `now()` reads.
private func ffmpegStrip(path: String, frames n: Int, sprite: Sprite, deadline: Double) throws -> [Double] {
    let key = FileKey.of(path)
    let plan = try fallbackTier0(path: path, size: key?.size ?? 0, mtime: key?.mtime ?? 0, reason: "strip").plan
    guard plan.durationS > 0 else { throw StripError.message(noFrames) }
    let times = (0..<n).map { (Double($0) + 0.5) / Double(n) * plan.durationS }
    let lock = NSLock()
    var images: [Int: Data] = [:]
    DispatchQueue.concurrentPerform(iterations: n) { i in
        let left = (deadline - now()) / 1000
        guard left > 0.05, let raw = fallbackStripFrame(path: path, at: times[i], width: sprite.width, height: sprite.height,
                                                         timeout: left) else { return }
        lock.lock()
        images[i] = raw
        lock.unlock()
    }
    guard images.count == n else {
        throw StripError.message(now() >= deadline ? stripTooLong : "ffmpeg couldn't read frames from this clip.")
    }
    for (i, raw) in images {
        raw.withUnsafeBytes { p in
            sprite.put(i, from: p.baseAddress!, rowBytes: sprite.width * 4, w: sprite.width, h: sprite.height, rotation: 0)
        }
    }
    if plan.color.convert { sprite.gradeLogFrames() }
    return times.map { ($0 * 1000).rounded() / 1000 }
}

let stripTooLong = "Making this strip took too long."

/// Writes the picture and its JSON under names of their own. Nil, with nothing left behind, when either can't be written.
private func writeTemps(_ sprite: Sprite, fields: String, files: StripFiles) -> (jpeg: String, meta: String)? {
    let pid = getpid()
    let t = (jpeg: files.dir + "/" + files.name + ".\(pid).jpg.tmp", meta: files.dir + "/" + files.name + ".\(pid).json.tmp")
    noteStripTemp(t.jpeg, t.meta)
    guard sprite.writeJPEG(to: t.jpeg), FileManager.default.createFile(atPath: t.meta, contents: Data(fields.utf8)) else {
        unlink(t.jpeg)
        unlink(t.meta)
        noteStripTemp(nil, nil)
        return nil
    }
    return t
}

/// Set only by engine/tests/contract.sh: the strip waits this many seconds between its two renames, so it finishes past its
/// deadline.
private let testCommitWait = ProcessInfo.processInfo.environment["ENGINE_TEST_STRIP_COMMIT_WAIT"].flatMap(Double.init)

/// Puts a written strip in place: the JSON first, then the picture. A strip is read only when both are there, so it counts
/// from the second rename. False, with neither left, when a rename fails. A stop between the two removes the JSON as well.
private func commit(_ t: (jpeg: String, meta: String), files: StripFiles) -> Bool {
    defer { noteStripTemp(nil, nil) }
    guard rename(t.meta, files.meta) == 0 else {
        unlink(t.jpeg)
        unlink(t.meta)
        return false
    }
    noteStripTemp(t.jpeg, files.meta)
    if let wait = testCommitWait { usleep(useconds_t(wait * 1e6)) }
    guard rename(t.jpeg, files.jpeg) == 0 else {
        unlink(t.jpeg)
        unlink(files.meta)
        return false
    }
    return true
}

/// Where a run stands, read and written only under its lock. `kept` means the strip is whole on disk. Once `abandoned`,
/// nothing more may be kept, and the answer is that it took too long.
private enum StripState {
    case working
    case kept(String)
    case failed(String)
    case abandoned
}

/// The cached strip's fields, when its picture and its JSON are both there and the JSON is whole.
private func cachedStrip(_ files: StripFiles) -> String? {
    guard access(files.jpeg, R_OK) == 0, let data = FileManager.default.contents(atPath: files.meta),
          let text = String(data: data, encoding: .utf8),
          (try? JSONSerialization.jsonObject(with: Data("{\(text)}".utf8))) != nil else { return nil }
    return text
}

func runStrip(_ a: [String]) {
    let start = now()
    var path: String?
    var frames = stripDefaultFrames, width = stripDefaultWidth
    var cacheDir = NSString(string: "~/Library/Caches/\(bundleId)").expandingTildeInPath
    var i = 0
    func value() -> String {
        i += 1
        guard i < a.count else { usage() }
        return a[i]
    }
    while i < a.count {
        switch a[i] {
        case "--path": path = value()
        case "--frames":
            guard let n = Int(value()), (2...32).contains(n) else { usage() }
            frames = n
        case "--width":
            guard let w = Int(value()), (64...1024).contains(w) else { usage() }
            width = w
        case "--cache": cacheDir = NSString(string: value()).expandingTildeInPath
        default: usage()
        }
        i += 1
    }
    guard let path, !path.isEmpty else { usage() }
    let height = max(2, (width * 9 / 16 + 1) / 2 * 2)
    let output = Output()
    let jsonPath = jsonString(path)
    func fail(_ message: String) {
        var f = Fields()
        f.add("message", message)
        f.add("ms", now() - start, 1)
        output.emit("{\"type\":\"error\",\"path\":\(jsonPath),\(f.joined)}")
    }
    func answer(_ files: StripFiles, _ fields: String, cached: Bool) {
        output.emit("{\"type\":\"strip\",\"path\":\(jsonPath),\"file\":\(jsonString(files.jpeg)),\(fields),\"cached\":\(cached),"
                    + "\"ms\":\(String(format: "%.1f", now() - start))}")
    }

    guard let key = FileKey.of(path) else { return fail(String(cString: strerror(errno))) }
    let files = StripFiles(dir: cacheDir + "/strips", stem: stripStem(jsonPath: jsonPath, key: key), frames: frames, width: width)
    if let fields = cachedStrip(files) { return answer(files, fields, cached: true) }

    // The work runs on its own thread so the deadline holds whatever it's stuck in. Past it, nothing more may be kept.
    let deadline = start + stripDeadline * 1000
    let done = DispatchSemaphore(value: 0)
    let gate = NSLock()
    var state = StripState.working
    func settle(_ next: StripState) {
        gate.lock()
        if case .working = state { state = next }
        gate.unlock()
        done.signal()
    }
    let worker = Thread {
        testHang("strip", path: path)
        var sprite = Sprite(frames: frames, width: width, height: height)
        let times: [Double]
        if let direct = directStrip(path: path, frames: frames, sprite: sprite) {
            times = direct
        } else {
            // The direct route may have filled some frames before it gave up, so the slow route starts clean.
            sprite = Sprite(frames: frames, width: width, height: height)
            do {
                times = try ffmpegStrip(path: path, frames: frames, sprite: sprite, deadline: deadline)
            } catch {
                return settle(.failed((error as? StripError)?.description ?? "\(error)"))
            }
        }
        let distinct = Set(times).count
        var f = Fields()
        f.add("frames", frames)
        f.add("frameWidth", width)
        f.add("frameHeight", height)
        f.addRaw("times", "[" + times.map { String(format: "%.3f", $0) }.joined(separator: ",") + "]")
        f.add("distinct", distinct)
        try? FileManager.default.createDirectory(atPath: files.dir, withIntermediateDirectories: true)
        guard let temps = writeTemps(sprite, fields: f.joined, files: files) else {
            return settle(.failed("The strip couldn't be written to \(files.dir)."))
        }
        // The renames happen under the lock, so the deadline can't fall between them: the strip is kept whole and the answer
        // says so, or nothing is kept and the answer is that it took too long.
        gate.lock()
        if case .working = state {
            state = commit(temps, files: files) ? .kept(f.joined) : .failed("The strip couldn't be written to \(files.dir).")
        } else {
            unlink(temps.jpeg)
            unlink(temps.meta)
        }
        gate.unlock()
        done.signal()
    }
    worker.qualityOfService = .userInitiated
    worker.stackSize = 1 << 22
    worker.start()

    let wait = max(0, deadline - now()) / 1000
    if done.wait(timeout: .now() + wait) == .timedOut {
        // Waits for a rename under way, so a strip finishing at this moment is answered as kept.
        gate.lock()
        if case .working = state { state = .abandoned }
        let final = state
        gate.unlock()
        if case .abandoned = final {
            stopChildren()
            removeStripTemp()
            fail(stripTooLong)
            _exit(0)
        }
    }
    gate.lock()
    let final = state
    gate.unlock()
    switch final {
    case .kept(let fields): answer(files, fields, cached: false)
    case .failed(let message): fail(message)
    case .working, .abandoned: fail(noFrames)
    }
}
