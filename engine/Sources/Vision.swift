import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import Vision

/// What Vision saw in one frame.
struct FrameVision {
    var labels: [(name: String, conf: Float)] = []
    var faces: [CGRect] = []
    var people: [CGRect] = []
    var faceConf: [Float] = []
    var peopleConf: [Float] = []
    var words: [(text: String, conf: Float)] = []
    var print: [Float]?
    var printRevision = 0
    /// Which requests answered. One that failed saw nothing, so its empty list above means unknown, not none.
    var labelsKnown = true
    var facesKnown = true
    var peopleKnown = true
    var wordsKnown = true
}

/// The requests that finished without an error in the current `look`. Vision calls the completion handlers before `perform`
/// returns, but on its own threads and several at once, so this is locked.
private final class Answered {
    private var ids = Set<ObjectIdentifier>()
    private let lock = NSLock()
    func note(_ r: VNRequest, _ e: Error?) {
        guard e == nil, r.results != nil else { return }
        lock.lock()
        ids.insert(ObjectIdentifier(r))
        lock.unlock()
    }
    func has(_ r: VNRequest) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return ids.contains(ObjectIdentifier(r))
    }
    func reset() {
        lock.lock()
        ids.removeAll(keepingCapacity: true)
        lock.unlock()
    }
}

/// Set only by engine/tests/contract.sh: for a clip whose path contains "vfail", the named requests fail, as a framework would.
private let testFailures = Set((ProcessInfo.processInfo.environment["ENGINE_TEST_VISION_FAIL"] ?? "").split(separator: ",").map(String.init))

/// One set of requests per worker thread. A request isn't safe to share, and they all run through one handler,
/// which shares the scaled copies Vision makes and costs about half of running them apart.
final class VisionWorker {
    private let answered: Answered
    private let classify: VNClassifyImageRequest
    private let faces: VNDetectFaceRectanglesRequest
    private let humans: VNDetectHumanRectanglesRequest
    private let print: VNGenerateImageFeaturePrintRequest
    private let text: VNRecognizeTextRequest
    private let textBoxes: VNDetectTextRectanglesRequest
    private let requests: [VNRequest]

    init() {
        let a = Answered()
        answered = a
        classify = VNClassifyImageRequest(completionHandler: a.note)
        faces = VNDetectFaceRectanglesRequest(completionHandler: a.note)
        humans = VNDetectHumanRectanglesRequest(completionHandler: a.note)
        print = VNGenerateImageFeaturePrintRequest(completionHandler: a.note)
        text = VNRecognizeTextRequest(completionHandler: a.note)
        textBoxes = VNDetectTextRectanglesRequest(completionHandler: a.note)
        humans.upperBodyOnly = false
        text.recognitionLevel = .fast
        text.usesLanguageCorrection = true      // turns a misread sign into the word, and gives a confidence worth reading
        // Not every macOS reads every language at this level, and asking for one it can't would fail the request.
        let languages = (try? text.supportedRecognitionLanguages()) ?? []
        if let r = ProcessInfo.processInfo.environment["ENGINE_TEST_PRINT_REVISION"].flatMap(Int.init) { print.revision = r }
        text.recognitionLanguages = ["fr-FR", "en-US"].filter(languages.contains)
        requests = [classify, faces, humans, print, textBoxes]
    }

    /// Stops whatever this worker is doing, from another thread. Vision then returns from `perform` with an error.
    func cancel() { (requests + [text]).forEach { $0.cancel() } }

    /// For the contract test: asks for a revision no Mac has, which Vision answers with an error for that request.
    private func breakForTest(_ path: String) -> [(VNRequest, Int)] {
        guard !testFailures.isEmpty, path.contains("vfail") else { return [] }
        let named: [(String, VNRequest)] = [("classify", classify), ("faces", faces), ("people", humans), ("print", print),
                                            ("boxes", textBoxes), ("text", text)]
        return named.filter { testFailures.contains($0.0) }.map { _, r in
            let was = r.revision
            r.revision = 9999
            return (r, was)
        }
    }

    func look(at image: CVPixelBuffer, orientation: CGImagePropertyOrientation, path: String = "") -> FrameVision? {
        testHang("vision", path: path)
        if fakeVision { return fakeLook(image) }
        let broken = breakForTest(path)
        defer { for (r, was) in broken { r.revision = was } }
        // One request failing mustn't cost the others, so each one's own answer is read below. Vision also cancels the rest of
        // a perform when one request fails, so a failure is never read as an empty answer.
        answered.reset()
        let handler = VNImageRequestHandler(cvPixelBuffer: image, orientation: orientation)
        try? handler.perform(requests)
        // Reading words is the slowest request by far, and it barely runs in parallel: 7.6 ms a frame on any number of threads,
        // against 0.5 ms for finding where text might be. Most frames have none, so only those that do get read.
        let boxesKnown = answered.has(textBoxes)
        let mayHaveWords = boxesKnown && !(textBoxes.results ?? []).isEmpty
        if mayHaveWords { try? handler.perform([text]) }
        guard answered.has(classify) || answered.has(faces) || answered.has(humans) || answered.has(print) else { return nil }
        // A request that failed keeps whatever it had from the frame before, so only an answered one is read.
        var out = FrameVision()
        out.labelsKnown = answered.has(classify)
        out.facesKnown = answered.has(faces)
        out.peopleKnown = answered.has(humans)
        out.wordsKnown = boxesKnown && (!mayHaveWords || answered.has(text))
        if out.labelsKnown, let all = classify.results {
            // Apple ships a precision curve for every label. This keeps a label only where the curve says at least 75% of such
            // calls are right, which suits labels better than one confidence for all 1,303 of them.
            out.labels = all.filter { $0.confidence >= 0.01 && $0.hasMinimumRecall(0.05, forPrecision: 0.75) }
                .map { ($0.identifier, $0.confidence) }
        }
        if out.facesKnown {
            out.faces = (faces.results ?? []).map(\.boundingBox)
            out.faceConf = (faces.results ?? []).map(\.confidence)
        }
        if out.peopleKnown {
            out.people = (humans.results ?? []).map(\.boundingBox)
            out.peopleConf = (humans.results ?? []).map(\.confidence)
        }
        if mayHaveWords, out.wordsKnown {
            out.words = (text.results ?? []).compactMap { $0.topCandidates(1).first }.map { ($0.string, $0.confidence) }
        }
        if answered.has(print), let p = print.results?.first, p.elementType == .float, p.elementCount > 0,
           p.data.count == p.elementCount * 4 {
            var values = [Float](repeating: 0, count: p.elementCount)
            _ = values.withUnsafeMutableBytes { p.data.copyBytes(to: $0) }
            out.print = values
            out.printRevision = print.revision
        }
        return out
    }
}

func orientation(forRotation r: Int) -> CGImagePropertyOrientation {
    switch r {
    case 90: return .right
    case 180: return .down
    case 270: return .left
    default: return .up
    }
}

/// The feature print revision this Mac makes, which every print in one grouping has to share. Tests can ask for another.
let currentPrintRevision: Int = {
    if let r = ProcessInfo.processInfo.environment["ENGINE_TEST_PRINT_REVISION"].flatMap(Int.init) { return r }
    return VNGenerateImageFeaturePrintRequest().revision
}()

/// Set only by engine/tests/scale.sh, which runs 50,000 clips: everything is real except the models, which would take hours.
/// The print comes from the frame's pixels, so identical clips still match.
private let fakeVision = ProcessInfo.processInfo.environment["ENGINE_TEST_FAKE_VISION"] != nil

private func fakeLook(_ image: CVPixelBuffer) -> FrameVision? {
    guard CVPixelBufferLockBaseAddress(image, .readOnly) == 0 else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(image) else { return nil }
    let bytes = CVPixelBufferGetBytesPerRow(image) * CVPixelBufferGetHeight(image)
    var seed: UInt64 = 0xcbf2_9ce4_8423_2325
    let p = base.assumingMemoryBound(to: UInt8.self)
    var i = 0
    while i < bytes {
        seed = (seed ^ UInt64(p[i])) &* 0x0000_0100_0000_01b3
        i += 97
    }
    var out = FrameVision()
    var values = [Float](repeating: 0, count: 768)
    for k in 0..<768 {
        seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        values[k] = Float(seed >> 40) / Float(1 << 24) * 0.07
    }
    out.print = values
    out.printRevision = currentPrintRevision
    return out
}
