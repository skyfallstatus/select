import CoreGraphics
import CoreVideo
import Foundation

// Tier 2: what's in the clip. It runs after Tier 1 has finished, so it can never hold those lines up, and nothing here
// can touch them: a clip that fails here just gets nulls. Everything runs on this Mac.

/// Long side of the frames fed to Vision. See docs/ENGINE.md for how this was chosen.
let visionSide = 1280

struct Tier2Result {
    var fields: String
    var print: ClipPrint?
    var remember: Bool
}

final class Tier2Worker {
    let vision = VisionWorker()
    let sound: SoundWorker?

    init(sound wantsSound: Bool = true) { sound = wantsSound ? SoundWorker() : nil }
}

func scaledSize(width: Int, height: Int) -> (Int, Int) {
    let scale = Double(visionSide) / Double(max(width, height, 1))
    if scale >= 1 { return (width & ~1, height & ~1) }
    return (max(2, Int((Double(width) * scale).rounded()) & ~1), max(2, Int((Double(height) * scale).rounded()) & ~1))
}

private func pixelBuffer(from raw: Data, width: Int, height: Int) -> CVPixelBuffer? {
    var pb: CVPixelBuffer?
    guard CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &pb) == 0, let pb,
          CVPixelBufferLockBaseAddress(pb, []) == 0 else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(pb, []) }
    guard let dest = CVPixelBufferGetBaseAddress(pb) else { return nil }
    let row = CVPixelBufferGetBytesPerRow(pb)
    raw.withUnsafeBytes { src in
        for y in 0..<height { memcpy(dest + y * row, src.baseAddress! + y * width * 4, width * 4) }
    }
    return pb
}

private func jsonNamed(_ items: [(name: String, conf: Double)]) -> String {
    "[" + items.map { "{\"name\":\(jsonString($0.name.replacingOccurrences(of: "_", with: " "))),\"conf\":\(String(format: "%.3f", $0.conf))}" }.joined(separator: ",") + "]"
}

/// The middle moment, seen while Tier 1 had the frame in hand. The decoder is what limits a scan, about 200 4K frames a second
/// here, so a frame already decoded is worth keeping: it takes a third off Tier 2.
struct MiddleLook {
    let offset: Int64
    let vision: FrameVision
    let colors: ColorSampler
}

func lookAtMiddle(_ image: CVPixelBuffer, color: ColorPlan, rotation: Int, offset: Int64, worker: Tier2Worker, path: String = "") -> MiddleLook? {
    testHang("middle", path: path)
    var colors = ColorSampler()
    colors.add(image, convert: color.convert)
    if color.sLog3 { gradeForVision(image) }
    guard let v = worker.vision.look(at: image, orientation: orientation(forRotation: rotation)) else { return nil }
    return MiddleLook(offset: offset, vision: v, colors: colors)
}

/// Looks at middle moments beside Tier 1. It takes what it can: a full queue drops the frame and Tier 2 decodes it again later,
/// so Tier 1 never waits for this. It keeps at most `keep` results, so a huge project costs a few more decodes rather than
/// memory. A job past its deadline is given up on, and once every thread is stuck the jobs still waiting are dropped
/// too, so `finish` always returns.
final class MiddleQueue {
    private var jobs: [(index: Int, image: CVPixelBuffer, color: ColorPlan, rotation: Int, offset: Int64, path: String)] = []
    private let lock = NSCondition()
    private var closed = false
    private var sealed = false
    private var accepted = 0
    private var running: [Int: (started: Double, worker: Tier2Worker)] = [:]
    private var results: [Int: MiddleLook] = [:]
    private let capacity = 32
    /// About 15 KB a look with the colour samples packed: about 90 MB at most, or half that on a Mac with less than 16 GB.
    private let keep = machineGB >= 16 ? 6144 : 3072
    private let deadline = tier2Deadline
    private let threads: Int
    /// Threads whose job ran past its deadline and hasn't come back.
    private var stuck = 0

    init(threads: Int) {
        self.threads = threads
        for _ in 0..<threads {
            let t = Thread { [self] in
                let worker = Tier2Worker(sound: false)
                while let job = next(worker) {
                    let look = autoreleasepool {
                        lookAtMiddle(job.image, color: job.color, rotation: job.rotation, offset: job.offset, worker: worker, path: job.path)
                    }
                    lock.lock()
                    if running.removeValue(forKey: job.index) != nil {
                        if !sealed, let look { results[job.index] = look }
                    } else {
                        stuck -= 1              // given up on, and back after all
                    }
                    lock.broadcast()
                    lock.unlock()
                }
            }
            t.qualityOfService = .userInitiated
            t.stackSize = 1 << 22
            t.start()
        }
    }

    private func next(_ worker: Tier2Worker) -> (index: Int, image: CVPixelBuffer, color: ColorPlan, rotation: Int, offset: Int64, path: String)? {
        lock.lock()
        defer { lock.unlock() }
        while jobs.isEmpty {
            if closed { return nil }
            lock.wait()
        }
        let job = jobs.removeFirst()
        running[job.index] = (now(), worker)
        return job
    }

    func offer(_ index: Int, image: CVPixelBuffer, color: ColorPlan, rotation: Int, offset: Int64, path: String) {
        lock.lock()
        defer { lock.unlock() }
        guard jobs.count < capacity, accepted < keep, !closed else {
            trace.route("middle-dropped")
            return
        }
        accepted += 1
        jobs.append((index, image, color, rotation, offset, path))
        lock.signal()
    }

    /// Waits for the queue to empty. A job running past its deadline is cancelled and given up on. When no thread is left to
    /// take the jobs still waiting, they're dropped: Tier 2 decodes those moments again itself.
    func finish() {
        lock.lock()
        closed = true
        lock.broadcast()
        while !jobs.isEmpty || !running.isEmpty {
            let t = now()
            for (index, job) in running where t - job.started > deadline * 1000 {
                running[index] = nil
                stuck += 1
                job.worker.vision.cancel()
                trace.route("middle-late")
            }
            if stuck >= threads, !jobs.isEmpty {
                for _ in jobs { trace.route("middle-dropped") }
                jobs.removeAll()
            }
            if jobs.isEmpty && running.isEmpty { break }
            lock.wait(until: Date().addingTimeInterval(0.1))
        }
        sealed = true
        lock.unlock()
    }

    /// The result for a clip, handed over once: Tier 2 takes it and the queue forgets it.
    func take(_ index: Int) -> MiddleLook? {
        lock.lock()
        defer { lock.unlock() }
        return results.removeValue(forKey: index)
    }
}

/// Set only by engine/tests/contract.sh: for a clip whose path contains "rfail", reading its last moment fails, as a pulled
/// cable or a bad block would.
private let testReadFailure = ProcessInfo.processInfo.environment["ENGINE_TEST_READ_FAIL"] != nil
private func testReadFails(_ path: String, moment: Int, of count: Int) -> Bool {
    testReadFailure && count > 1 && moment == count - 1 && path.contains("rfail")
}

/// Set only by engine/tests/contract.sh: for a clip whose path contains "dfail", the decoder refuses its last moment, as it
/// would a damaged GOP.
private let testDecodeFailure = ProcessInfo.processInfo.environment["ENGINE_TEST_DECODE_FAIL"] != nil
private func testDecodeFails(_ path: String, moment: Int, of count: Int) -> Bool {
    testDecodeFailure && count > 1 && moment == count - 1 && path.contains("dfail")
}

func tier2(path: String, plan: ClipPlan, pool: DecoderPool, worker: Tier2Worker, middle: MiddleLook?) -> Tier2Result {
    let file = try? MediaFile(path: path)
    var rtmd = RtmdValues()
    var mark = now()
    func lap(_ name: String) {
        if trace.path != nil {
            let n = now()
            trace.add(name, n - mark)
            mark = n
        }
    }
    if let p = plan.rtmd, let file { rtmd = readRtmd(p, file: file) }
    lap("rtmd")

    // Picture. Each moment reaches `use` as a small BGRA image.
    var seen: [FrameVision] = []
    var blind = 0                   // moments decoded that Vision couldn't answer at all
    var colors = ColorSampler()
    let turn = orientation(forRotation: plan.rotation)
    func use(_ image: CVPixelBuffer) {
        autoreleasepool {
            lap("decode")
            colors.add(image, convert: plan.color.convert)
            if plan.color.sLog3 { gradeForVision(image) }
            lap("color")
            if let v = worker.vision.look(at: image, orientation: turn, path: path) { seen.append(v) } else { blind += 1 }
            lap("vision")
        }
    }
    // A moment that couldn't be read, as when a cable is pulled, may read next time, so while one is missing what it held is
    // unknown. A moment the decoder refused stays refused, as a damaged GOP does: the clip is judged on the moments that
    // decoded, as 0.3 did, and the result is kept. Only a clip with no moment decoded goes the slow way.
    var unread = 0
    var undecoded = 0
    var slow = plan.fallback || plan.moments.isEmpty
    if !slow, let file {
        for (n, m) in plan.moments.enumerated() {
            if let middle, middle.offset == m.offset {
                seen.append(middle.vision)
                colors.merge(middle.colors)
                continue
            }
            guard !testReadFails(path, moment: n, of: plan.moments.count),
                  let sample = try? file.read(at: m.offset, count: m.size), sample.count == m.size else {
                unread += 1
                continue
            }
            lap("read")
            let (w, h) = scaledSize(width: m.codedWidth, height: m.codedHeight)
            if testDecodeFails(path, moment: n, of: plan.moments.count) {
                undecoded += 1
            } else if case .refused = pool.decodeScaled(m, sample: sample, width: w, height: h, body: { image, _ in use(image) }) {
                undecoded += 1
            }
        }
        slow = seen.isEmpty && undecoded > 0
    }
    if slow, seen.isEmpty, ffmpegPath != nil, plan.width > 1, plan.height > 1 {
        var (w, h) = (plan.width, plan.height)
        if !plan.fallback, plan.rotation == 90 || plan.rotation == 270 { swap(&w, &h) }
        let (sw, sh) = scaledSize(width: w, height: h)
        let times = plan.durationS > 3 ? [1.0, 3.0, 5.0].map { plan.durationS * $0 / 6 } : [plan.durationS / 2]
        // ffmpeg failing at one time is the same as the decoder refusing a moment: the others stand.
        for t in times {
            guard let raw = fallbackImage(path: path, at: t, width: sw, height: sh),
                  let image = pixelBuffer(from: raw, width: sw, height: sh) else { continue }
            use(image)
        }
    }

    var out = Fields()
    out.add("moments", seen.count)
    let looked = !seen.isEmpty
    // A field is reported only when its request answered at every moment decoded, and no moment went unread. One that failed
    // anywhere gives null: a missed moment could have held the face or the word. People and shot size also use faces and labels.
    let allSeen = blind == 0 && unread == 0
    let labelsKnown = allSeen && seen.allSatisfy(\.labelsKnown)
    let facesKnown = allSeen && seen.allSatisfy(\.facesKnown)
    let peopleKnown = labelsKnown && facesKnown && seen.allSatisfy(\.peopleKnown)
    let wordsKnown = allSeen && seen.allSatisfy(\.wordsKnown)
    let peopleCounts = seen.map { countPeople($0) }
    let faceCounts = seen.map { countFaces($0) }
    out.add("people", looked && peopleKnown ? peopleCounts.max() : nil)
    out.add("faces", looked && facesKnown ? faceCounts.max() : nil)
    out.add("shotSize", looked && peopleKnown ? shotSize(seen) : nil)
    out.addRaw("labels", looked && labelsKnown ? jsonNamed(chooseLabels(seen)) : nil)
    out.addRaw("text", looked && wordsKnown ? "[" + chooseWords(seen).map(jsonString).joined(separator: ",") + "]" : nil)

    // Sound.
    var sounds: [(name: String, conf: Double)]?
    var speech: Bool?, music: Bool?
    if plan.hasAudio {
        lap("other")
        // The loudest track is the one listened to. Silence counts only when every track was heard.
        let direct = file.map { f in plan.sound.compactMap { readMono($0, file: f) } } ?? []
        var mono = direct.max { $0.energy < $1.energy }
        var allHeard = direct.count >= plan.audioTracks
        lap("soundread")
        if mono == nil || (!allHeard && mono!.energy < 1e-6),
           let slow = fallbackMono(path: path, duration: plan.durationS, streams: plan.audioStreams) {
            mono = slow
            allHeard = true
        }
        if let mono {
            if mono.energy < 1e-6 {          // quieter than -60 dBFS: nothing to listen to
                if allHeard { (sounds, speech, music) = ([], false, false) }
            } else if let heard = autoreleasepool(invoking: { worker.sound?.classify(mono, path: path) }) {
                (sounds, speech, music) = chooseSounds(heard)
            }
        }
    }
    lap("soundnet")
    out.addRaw("sounds", sounds.map(jsonNamed))
    out.add("speech", speech)
    out.add("music", music)

    // The camera's own record.
    out.add("iso", rtmd.iso)
    out.add("shutterS", rtmd.shutterS, 6)
    out.add("aperture", rtmd.aperture, 2)
    out.add("shake", rtmd.shakeDegPerS.map(shakeScore), 3)

    // Colour.
    let color = looked ? colors.finish() : nil
    out.add("colorHue", color?.hue, 1)
    out.add("colorChroma", color?.chroma, 3)
    out.add("colorLight", color?.light, 3)
    out.add("colorName", color?.name)
    out.addRaw("palette", color.map { "[" + $0.palette.map(jsonString).joined(separator: ",") + "]" })
    // Prints from one revision only.
    var print: ClipPrint?
    let prints = seen.compactMap(\.print)
    if let first = seen.first(where: { $0.print != nil }), prints.allSatisfy({ $0.count == prints[0].count }) {
        let mean = colors.mean
        print = ClipPrint(values: prints.flatMap { $0 }, count: prints.count, revision: first.printRevision, a: mean?.a ?? 0, b: mean?.b ?? 0)
    }
    // A clip that should have had a picture or sound and didn't may do better next time, so that's never remembered, and
    // neither is one with a field left unknown.
    let complete = peopleKnown && wordsKnown && seen.allSatisfy { $0.print != nil }
    return Tier2Result(fields: out.joined, print: print, remember: looked && complete && print != nil && (!plan.hasAudio || sounds != nil))
}

// Everything below decides what counts. The numbers come from looking at real clips, not from defaults.

/// The face detector rarely invents much, but the smallest boxes are mostly noise in a crowd or a pattern.
private let smallestFace: CGFloat = 0.012
func countFaces(_ v: FrameVision) -> Int { v.faces.filter { $0.height >= smallestFace }.count }

/// The people detector sees figures in walls, sculptures and buildings, so a box only counts when the classifier agrees there
/// are people in the frame, or a face was found.
private let personWords: Set<String> = ["people", "adult", "child", "baby", "crowd"]
func peopleBoxes(_ v: FrameVision) -> [CGRect] {
    guard countFaces(v) > 0 || v.labels.contains(where: { personWords.contains($0.name) }) else { return [] }
    return zip(v.people, v.peopleConf).filter { $0.1 >= 0.5 }.map(\.0)
}
func countPeople(_ v: FrameVision) -> Int { max(peopleBoxes(v).count, countFaces(v) > 0 ? 1 : 0) }

/// Head height against frame height, in the display orientation, which reads the same on a tall frame as a wide one. Calibrated
/// on real clips, most of them portrait: this puts head-to-knee framing in medium. There is no close-up: on real footage it
/// almost never came up, so a tight face is medium too.
private let mediumFace: CGFloat = 0.12
private let smallestMediumFace: CGFloat = 0.07
private let mediumBody: CGFloat = 0.75
/// A person who runs off the bottom of the frame isn't a wide shot, however small the head is against a tall frame.
private let cutOffBody: CGFloat = 0.5
private let frameBottom: CGFloat = 0.015

private func shotSize(_ v: FrameVision) -> String? {
    let bodies = peopleBoxes(v)
    let cutOff = bodies.contains { $0.minY <= frameBottom && $0.height >= cutOffBody }
    if let face = v.faces.map(\.height).filter({ $0 >= smallestFace }).max() {
        return face >= mediumFace || (cutOff && face >= smallestMediumFace) ? "medium" : "wide"
    }
    guard let body = bodies.map(\.height).max() else { return nil }
    return body >= mediumBody || cutOff ? "medium" : "wide"
}

/// The size most moments agree on. A tie goes to the tighter shot, which is what an editor would call it.
func shotSize(_ seen: [FrameVision]) -> String? {
    var votes: [String: Int] = [:]
    for v in seen { if let s = shotSize(v) { votes[s, default: 0] += 1 } }
    return ["medium", "wide"].max { votes[$0, default: 0] < votes[$1, default: 0] }.flatMap { votes[$0] == nil ? nil : $0 }
}

func chooseLabels(_ seen: [FrameVision]) -> [(name: String, conf: Double)] {
    var best: [String: Double] = [:]
    for v in seen {
        for l in v.labels { best[l.name] = max(best[l.name] ?? 0, Double(l.conf)) }
    }
    return best.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.prefix(12).map { ($0.key, $0.value) }
}

/// `.fast` reads signs well and everything else badly. These rules keep words a person could have written. Fragments of three
/// letters were more often junk than words on real clips, so four is the shortest.
private func plausibleWord(_ w: String) -> Bool {
    let letters = w.filter(\.isLetter)
    guard letters.count >= 4, w.allSatisfy({ $0.isLetter || "'’-".contains($0) }) else { return false }
    let shape = w == w.uppercased() || w == w.lowercased() || w == w.prefix(1).uppercased() + w.dropFirst().lowercased()
    guard shape else { return false }
    let strokes = letters.filter { "IiLlJj".contains($0) }.count
    let vowels = letters.lowercased().filter { "aeiouyàâéèêëîïôöùûü".contains($0) }.count
    return strokes * 2 < letters.count && vowels * 5 >= letters.count && vowels < letters.count
}

func chooseWords(_ seen: [FrameVision]) -> [String] {
    var out: [String] = []
    for v in seen {
        for candidate in v.words where candidate.conf >= 0.5 {
            for raw in candidate.text.split(separator: " ") {
                let w = raw.trimmingCharacters(in: .punctuationCharacters)
                if plausibleWord(w), !out.contains(where: { $0.caseInsensitiveCompare(w) == .orderedSame }) { out.append(w) }
            }
        }
    }
    return Array(out.prefix(12))
}

func chooseSounds(_ heard: [String: Double]) -> ([(name: String, conf: Double)], Bool, Bool) {
    let top = heard.filter { $0.value >= 0.3 }.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
        .prefix(6).map { (name: $0.key, conf: $0.value) }
    let speech = ["speech", "conversation", "narration_monologue"].contains { (heard[$0] ?? 0) >= 0.5 }
    return (top, speech, (heard["music"] ?? 0) >= 0.5)
}

/// Angular jitter on a log scale. Calibrated on real clips: tripods read 0.2 to 0.9 deg/s, handheld 1.5 to 4, whip moves 20 and up.
func shakeScore(_ degPerS: Double) -> Double { max(0, min(1, log10(max(degPerS, 0.01) / 0.3) / 2)) }
