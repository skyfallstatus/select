import CoreVideo
import Foundation

func log(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

func usage() -> Never {
    log("usage: \(engineName) scan --paths-file <file|-> [--tier 0|1|2] [--cache <dir>] [--workers <n>] [--no-thumbs] [--cache-limit-mb <n>]")
    log("       \(engineName) version | --version")
    exit(2)
}

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }

/// stdout is flushed per line. A closed pipe ends the run at once, since nobody is listening.
final class Output {
    private let lock = NSLock()
    func emit(_ s: String) {
        lock.lock()
        defer { lock.unlock() }
        let line = s + "\n"
        let failed = line.withCString { c -> Bool in
            var left = strlen(c)
            var p = UnsafeRawPointer(c)
            while left > 0 {
                let n = write(1, p, left)
                if n < 0 {
                    if errno == EINTR { continue }
                    return true
                }
                left -= n
                p += n
            }
            return false
        }
        if failed {
            stopChildren()
            _exit(0)
        }
    }
}

struct Options {
    var pathsFile = ""
    var tier = 2
    var cacheDir = NSString(string: "~/Library/Caches/\(bundleId)").expandingTildeInPath
    var workers: Int?
    var thumbs = true
    /// The cache is kept under this many bytes, oldest first. 2 GB holds about 50,000 clips.
    var cacheLimit: Int64 = 2 << 30
}

func parseOptions(_ a: [String]) -> Options {
    var o = Options()
    var i = 0
    func value() -> String {
        i += 1
        guard i < a.count else { usage() }
        return a[i]
    }
    while i < a.count {
        switch a[i] {
        case "--paths-file": o.pathsFile = value()
        case "--tier":
            guard let t = Int(value()), (0...2).contains(t) else { usage() }
            o.tier = t
        case "--cache": o.cacheDir = NSString(string: value()).expandingTildeInPath
        case "--workers":
            guard let n = Int(value()), n > 0, n <= 128 else { usage() }
            o.workers = n
        case "--no-thumbs": o.thumbs = false
        case "--cache-limit-mb":
            guard let n = Int64(value()), n >= 1 else { usage() }
            o.cacheLimit = n << 20
        default: usage()
        }
        i += 1
    }
    if o.pathsFile.isEmpty { usage() }
    return o
}

func readPaths(_ source: String) -> [String]? {
    let data: Data
    if source == "-" {
        data = FileHandle.standardInput.readDataToEndOfFile()
    } else {
        guard let d = FileManager.default.contents(atPath: source) else { return nil }
        data = d
    }
    // Only a real newline ends a path: Swift's isNewline also splits on CR, U+0085 and U+2028, all legal in file names.
    return data.split(separator: 10).map { String(decoding: $0, as: UTF8.self) }
        .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
}

/// Per-clip timings for benchmarks. Off unless ENGINE_TRACE names a file.
final class Trace {
    private var rows: [String] = []
    private let lock = NSLock()
    let path = ProcessInfo.processInfo.environment["ENGINE_TRACE"]
    var routes: [String: Int] = [:]
    var totals: [String: Double] = [:]
    func add(_ name: String, _ ms: Double) {
        lock.lock()
        totals[name, default: 0] += ms
        lock.unlock()
    }
    func route(_ r: String) {
        lock.lock()
        routes[r, default: 0] += 1
        lock.unlock()
    }
    func row(_ s: @autoclosure () -> String) {
        guard path != nil else { return }
        let line = s()
        lock.lock()
        rows.append(line)
        lock.unlock()
    }
    func flush() {
        if let path { FileManager.default.createFile(atPath: path, contents: Data((rows.joined(separator: "\n") + "\n").utf8)) }
    }
}

let trace = Trace()

struct Tier1Timing {
    var read = 0.0, decode = 0.0, analyze = 0.0, audio = 0.0, thumb = 0.0
    var route = ""
}

/// Why a clip has no picture scores, in words for the person reading the panel.
func noPictureReason(_ plan: ClipPlan, _ why: DecodeFailure?) -> String {
    let code = why.map { $0.status != 0 ? " (error \($0.status))" : "" } ?? ""
    let macSide: String
    switch why {
    case let w? where w.noDecoder: macSide = "This Mac has no decoder for \(plan.formatName)\(code)"
    case .some: macSide = "This Mac couldn't decode a frame from this clip\(code)"
    case nil: macSide = "This clip has no frame \(productName) can read"
    }
    if ffmpegPath == nil { return macSide + ", and ffmpeg isn't installed. File details are fine, picture scores are blank." }
    return macSide + ", and ffmpeg couldn't read it either. File details are fine, picture scores are blank."
}

/// `remember` is false for a result that installing ffmpeg would change.
func tier1(path: String, plan: ClipPlan, pool: DecoderPool, thumbPath: String?, shrinker: FrameShrinker?) throws
    -> (fields: String, timing: Tier1Timing, remember: Bool, middle: CVPixelBuffer?) {
    var timing = Tier1Timing()
    let file = try MediaFile(path: path)
    var metrics: Metrics?
    var refused: DecodeFailure?
    var middle: CVPixelBuffer?
    var t = now()
    let convertLog = plan.color.convert
    if let v = plan.video, !plan.fallback {
        let sample = try file.read(at: v.offset, count: v.size)
        guard sample.count == v.size else { throw MP4Error.truncated }
        timing.read = now() - t
        t = now()
        var decodedAt = 0.0
        let result = pool.decode(v, sample: sample) { frame, hw, image -> Metrics? in
            decodedAt = now()
            timing.route = hw ? "vt-hw" : "vt-sw"
            middle = shrinker?.shrink(image, plan: v)
            return analyze(frame, rotation: plan.rotation, sourceBits: plan.bitDepth, convertLog: convertLog, thumbPath: thumbPath)
        }
        switch result {
        case .frame(let m): metrics = m
        case .refused(let why): refused = why
        }
        if metrics != nil {
            timing.decode = decodedAt - t
            timing.analyze = now() - decodedAt
        }
    }
    if metrics == nil {
        t = now()
        timing.route = ffmpegPath == nil ? "none" : "ffmpeg"
        // ffmpeg is told not to rotate, so it wants the coded size rather than the display size.
        var slowPlan = plan
        if !plan.fallback, let v = plan.video {
            slowPlan.width = v.codedWidth
            slowPlan.height = v.codedHeight
        } else if !plan.fallback, plan.rotation == 90 || plan.rotation == 270 {
            swap(&slowPlan.width, &slowPlan.height)
        }
        metrics = fallbackFrame(path: path, plan: slowPlan) {
            analyze($0, rotation: plan.rotation, sourceBits: plan.bitDepth, convertLog: convertLog, thumbPath: thumbPath)
        } ?? nil
        timing.decode = now() - t
    }
    if metrics == nil { timing.route = "none" }
    timing.thumb = metrics?.thumbMs ?? 0

    t = now()
    let db = plan.hasAudio ? clipLevel(plan, path: path, file: file) : nil
    timing.audio = now() - t

    // A clip with no frame still has its file details and, usually, its sound.
    var out = Fields()
    out.add("sharpness", metrics?.sharpness, 4)
    out.add("luma", metrics?.luma, 4)
    out.add("contrast", metrics?.contrast, 4)
    out.add("clipHighPct", metrics?.clipHigh, 3)
    out.add("clipLowPct", metrics?.clipLow, 3)
    out.add("saturation", metrics?.saturation, 4)
    out.add("warmth", metrics?.warmth, 4)
    out.add("dhash", metrics?.dhash)
    out.add("audioDb", db, 2)
    out.add("silent", db.map { $0 < silenceDb })
    out.add("thumb", metrics?.thumbWritten == true ? thumbPath : nil)
    if metrics == nil { out.add("reason", noPictureReason(plan, refused)) }
    // A blank is never remembered: the cause may be one failed ffmpeg run, and the next scan should try again.
    return (out.joined, timing, metrics != nil, middle)
}

let silenceDb = -50.0

/// The loudest channel of any audio track, in dBFS. A clip is only called silent when every track was heard: a track that
/// couldn't be read may be the one with the sound, so then the level is unknown unless another track is clearly not silent.
func clipLevel(_ plan: ClipPlan, path: String, file: MediaFile) -> Double? {
    let direct = plan.audio.compactMap { measureAudio($0, file: file) }
    let loudest = direct.max()
    if direct.count >= plan.audioTracks, let loudest { return loudest }
    if let loudest, loudest >= silenceDb { return loudest }
    return fallbackAudioDb(path: path, duration: plan.durationS, streams: plan.audioStreams)
}

/// A Tier 1 line with nothing measured, and why.
func blankTier1Fields(_ reason: String) -> String {
    var f = Fields()
    for k in ["sharpness", "luma", "contrast", "clipHighPct", "clipLowPct", "saturation", "warmth"] { f.add(k, nil as Double?) }
    f.add("dhash", nil as String?)
    f.add("audioDb", nil as Double?)
    f.add("silent", nil as Bool?)
    f.add("thumb", nil as String?)
    f.add("reason", reason)
    return f.joined
}

/// When so many clips got stuck that no thread is left to replace them, the rest of the tier is skipped with these words.
let skippedTier0 = "Skipped, because reading earlier clips kept getting stuck. The drive may be slow or busy."
let skippedTier1 = "Skipped, because decoding earlier clips kept getting stuck, so picture scores are blank. File details are fine."
let skippedTier2 = "Skipped, because looking at earlier clips kept getting stuck, so these results are blank. The rest of the scan carried on."

/// A Tier 2 line with nothing in it, and why.
func blankTier2Fields(_ reason: String?) -> String {
    var f = Fields()
    f.add("moments", 0)
    for k in ["people", "faces", "iso"] { f.add(k, nil as Int?) }
    f.add("shotSize", nil as String?)
    for k in ["labels", "text", "sounds", "palette"] { f.addRaw(k, nil) }
    f.add("speech", nil as Bool?)
    f.add("music", nil as Bool?)
    for k in ["shutterS", "aperture", "shake", "colorHue", "colorChroma", "colorLight"] { f.add(k, nil as Double?) }
    f.add("colorName", nil as String?)
    if let reason { f.add("reason", reason) }
    return f.joined
}

func clipLine(tier: Int, path: String, cached: Bool, ms: Double, fields: String) -> String {
    "{\"type\":\"clip\",\"tier\":\(tier),\"path\":\(path),\"cached\":\(cached),\"ms\":\(String(format: "%.1f", ms)),\(fields)}"
}

func scan(_ o: Options) {
    guard let paths = readPaths(o.pathsFile) else {
        log("cannot read paths file \(o.pathsFile)")
        exit(2)
    }
    let start = now()
    let output = Output()
    let cache = ResultCache(dir: o.cacheDir)
    let workers0 = o.workers ?? defaultTier0Workers
    let workers1 = o.workers ?? defaultTier1Workers
    output.emit("{\"type\":\"start\",\"total\":\(paths.count),\"schema\":\(schemaVersion),\"engineVersion\":\"\(engineVersion)\"}")

    let count = paths.count
    let jsonPaths = paths.map(jsonString)
    let plans = UnsafeMutablePointer<ClipPlan?>.allocate(capacity: max(count, 1))
    plans.initialize(repeating: nil, count: max(count, 1))
    let keys = UnsafeMutablePointer<FileKey>.allocate(capacity: max(count, 1))
    keys.initialize(repeating: FileKey(), count: max(count, 1))
    let status = UnsafeMutablePointer<UInt8>.allocate(capacity: max(count, 1)) // 0 pending, 1 ok, 2 failed
    status.initialize(repeating: 0, count: max(count, 1))
    let fromCache = UnsafeMutablePointer<Bool>.allocate(capacity: max(count, 1))
    fromCache.initialize(repeating: false, count: max(count, 1))
    let noPicture = UnsafeMutablePointer<Bool>.allocate(capacity: max(count, 1))
    noPicture.initialize(repeating: false, count: max(count, 1))

    var middles: MiddleQueue?
    // Plans are kept from Tier 0 to save reading the file again. Past this many clips they're read again instead, so memory
    // stays flat on a huge project.
    let keepPlans = count <= 4096

    func fail(_ i: Int, _ error: Error, key: FileKey? = nil) {
        status[i] = 2
        var f = Fields()
        f.add("message", "\(error)")
        output.emit("{\"type\":\"error\",\"path\":\(jsonPaths[i]),\(f.joined)}")
        let transient = (error as? MP4Error)?.isTransient ?? true
        if let key, !transient { cache.store(kind: "e", jsonPath: jsonPaths[i], key: key, value: f.joined) }
    }

    // Each slot remembers its thread, so a late clip's ffmpeg can be stopped.
    let slotThreads = UnsafeMutablePointer<UInt32>.allocate(capacity: 256)
    slotThreads.initialize(repeating: 0, count: 256)
    func noteThread(_ slot: Int) { if slot < 256 { slotThreads[slot] = currentThreadID() } }
    func stopSlot(_ slot: Int) { if slot < 256 { stopChild(ofThread: slotThreads[slot]) } }

    runGuarded(workers0, items: count, stack: 1 << 20, deadline: tier0Deadline, body: { i, slot, claim in
        noteThread(slot)
        let path = paths[i]
        guard let key = FileKey.of(path) else {
            if claim() { fail(i, MP4Error.io(String(cString: strerror(errno)))) }
            return
        }
        keys[i] = key
        if let e = cache.lookup(jsonPaths[i], key: key) {
            if let err = e.error {
                guard claim() else { return }
                status[i] = 2
                output.emit("{\"type\":\"error\",\"path\":\(jsonPaths[i]),\(err)}")
                fromCache[i] = true
                return
            }
            if let fields = e.tier0 {
                guard claim() else { return }
                status[i] = 1
                fromCache[i] = true
                output.emit(clipLine(tier: 0, path: jsonPaths[i], cached: true, ms: 0, fields: fields))
                return
            }
        }
        let t0 = now()
        testHang("tier0", path: path)
        do {
            let r = try tier0(path: path)
            let ms = now() - t0
            guard claim() else { return }
            trace.route(r.plan.fallback ? "tier0-ffprobe" : "tier0-direct")
            trace.row("0\t\(ms)\t\(r.plan.fallback ? "ffprobe" : "direct")\t\(path)")
            plans[i] = r.plan
            status[i] = 1
            output.emit(clipLine(tier: 0, path: jsonPaths[i], cached: false, ms: ms, fields: r.fields))
            cache.store(kind: "0", jsonPath: jsonPaths[i], key: key, value: r.fields)
        } catch {
            if claim() { fail(i, error, key: key) }
        }
    }, late: { i in
        fail(i, MP4Error.io("Reading this file took too long, so it was skipped. The drive may be slow or busy."))
    }, skipped: { i in
        fail(i, MP4Error.io(skippedTier0))
    }, cancel: stopSlot)

    log(String(format: "tier0 phase %.0f ms", now() - start))
    if o.tier >= 1 {
        let pool = DecoderPool(capacity: max(8, workers1 * 2))
        middles = o.tier == 2 ? MiddleQueue(threads: 6) : nil
        let wantsMiddle = o.tier == 2
        let shrinkers = UnsafeMutablePointer<FrameShrinker?>.allocate(capacity: workers1 + 64)
        shrinkers.initialize(repeating: nil, count: workers1 + 64)
        runGuarded(workers1, items: count, stack: 1 << 20, deadline: tier1Deadline, body: { i, slot, claim in
            noteThread(slot)
            guard status[i] == 1 else { return }
            let path = paths[i]
            let key = keys[i]
            let thumb = o.thumbs ? cache.thumbPath(path: path, key: key) : nil
            if let e = cache.lookup(jsonPaths[i], key: key), let fields = e.tier1 {
                let thumbReady = !o.thumbs || e.noPicture || (e.thumb.map { access($0, R_OK) == 0 } ?? false)
                if thumbReady {
                    guard claim() else { return }
                    if e.noPicture { noPicture[i] = true }
                    output.emit(clipLine(tier: 1, path: jsonPaths[i], cached: true, ms: 0, fields: fields))
                    return
                }
            }
            fromCache[i] = false
            let t0 = now()
            testHang("tier1", path: path)
            do {
                let plan: ClipPlan
                if let p = plans[i] { plan = p } else { plan = try tier0(path: path).plan }
                let wantsLook = wantsMiddle && cache.lookup(jsonPaths[i], key: key)?.tier2 == nil
                if wantsLook, slot < workers1 + 64, shrinkers[slot] == nil { shrinkers[slot] = FrameShrinker() }
                let r = try tier1(path: path, plan: plan, pool: pool, thumbPath: thumb,
                                  shrinker: wantsLook && slot < workers1 + 64 ? shrinkers[slot] : nil)
                let ms = now() - t0
                guard claim() else { return }
                let tm = r.timing
                trace.route("tier1-" + tm.route)
                trace.row(String(format: "1\t%.2f\t%@\t%.2f\t%.2f\t%.2f\t%.2f\t%.2f\t%@", ms, tm.route, tm.read, tm.decode, tm.analyze, tm.thumb, tm.audio, path))
                output.emit(clipLine(tier: 1, path: jsonPaths[i], cached: false, ms: ms, fields: r.fields))
                if tm.route == "none" { noPicture[i] = true }
                if r.remember { cache.store(kind: "1", jsonPath: jsonPaths[i], key: key, value: r.fields) }
                if let image = r.middle, let offset = plan.video?.offset {
                    middles?.offer(i, image: image, color: plan.color, rotation: plan.rotation, offset: offset, path: path)
                }
                if !keepPlans { plans[i] = nil }
            } catch {
                if claim() { fail(i, error, key: key) }
            }
        }, late: { i in
            noPicture[i] = true
            output.emit(clipLine(tier: 1, path: jsonPaths[i], cached: false, ms: tier1Deadline * 1000,
                                 fields: blankTier1Fields("Decoding this clip took too long, so picture scores are blank. File details are fine.")))
        }, skipped: { i in
            guard status[i] == 1 else { return }
            noPicture[i] = true
            fromCache[i] = false
            output.emit(clipLine(tier: 1, path: jsonPaths[i], cached: false, ms: 0, fields: blankTier1Fields(skippedTier1)))
        }, cancel: stopSlot)
        pool.closeAll()
    }

    log(String(format: "tier1 phase done at %.0f ms", now() - start))
    middles?.finish()
    if o.tier == 2 {
        let workers2 = o.workers ?? defaultTier2Workers
        let sources = UnsafeMutablePointer<PrintSource?>.allocate(capacity: max(count, 1))
        sources.initialize(repeating: nil, count: max(count, 1))
        let pool = DecoderPool(capacity: max(8, workers2 * 2))
        let local = UnsafeMutablePointer<Tier2Worker?>.allocate(capacity: workers2 + 64)
        local.initialize(repeating: nil, count: workers2 + 64)
        runGuarded(workers2, items: count, stack: 1 << 22, deadline: tier2Deadline, body: { i, slot, claim in
            noteThread(slot)
            guard status[i] == 1 else { return }
            let key = keys[i]
            // A result without its print can't take part in grouping, and neither can a print from another Vision revision,
            // so both count as not there.
            if let fields = cache.lookup(jsonPaths[i], key: key)?.tier2,
               let stored = cache.storedPrint(jsonPaths[i], key: key), stored.revision == currentPrintRevision {
                guard claim() else { return }
                output.emit(clipLine(tier: 2, path: jsonPaths[i], cached: true, ms: 0, fields: fields))
                sources[i] = .stored(stored)
                return
            }
            fromCache[i] = false
            let t0 = now()
            let plan: ClipPlan?
            if let p = plans[i] { plan = p } else { plan = try? tier0(path: paths[i]).plan }
            plans[i] = nil
            guard let plan else {
                if claim() { output.emit(clipLine(tier: 2, path: jsonPaths[i], cached: false, ms: 0, fields: blankTier2Fields(nil))) }
                return
            }
            guard slot < workers2 + 64 else { return }
            if local[slot] == nil { local[slot] = Tier2Worker() }
            let r = tier2(path: paths[i], plan: plan, pool: pool, worker: local[slot]!, middle: middles?.take(i))
            guard claim() else { return }
            output.emit(clipLine(tier: 2, path: jsonPaths[i], cached: false, ms: now() - t0, fields: r.fields))
            var stored: PrintRef?
            if r.remember {
                cache.store(kind: "2", jsonPath: jsonPaths[i], key: key, value: r.fields)
                if let p = r.print { stored = cache.storePrint(p, jsonPath: jsonPaths[i], key: key) }
            }
            if let stored { sources[i] = .stored(stored) } else if let p = r.print { sources[i] = .held(p) }
        }, late: { i in
            output.emit(clipLine(tier: 2, path: jsonPaths[i], cached: false, ms: tier2Deadline * 1000,
                                 fields: blankTier2Fields("Looking at this clip took too long, so these results are blank. The rest of the scan carried on.")))
        }, skipped: { i in
            guard status[i] == 1 else { return }
            fromCache[i] = false
            output.emit(clipLine(tier: 2, path: jsonPaths[i], cached: false, ms: 0, fields: blankTier2Fields(skippedTier2)))
        }, cancel: { slot in
            if slot < workers2 + 64 { local[slot]?.vision.cancel() }
            stopSlot(slot)
        })
        pool.closeAll()
        log(String(format: "tier2 phase done at %.0f ms", now() - start))
        let groups = similarGroups(sources: (0..<count).map { sources[$0] }, folders: paths.map { ($0 as NSString).deletingLastPathComponent },
                                   sortKey: paths, revision: currentPrintRevision, load: cache.readPrint)
        let json = groups.enumerated().map { n, members in
            "{\"id\":\(n + 1),\"paths\":[" + members.map { jsonPaths[$0] }.joined(separator: ",") + "]}"
        }
        output.emit("{\"type\":\"groups\",\"groups\":[" + json.joined(separator: ",") + "]}")
        log(String(format: "groups done at %.0f ms", now() - start))
    }
    cache.maintain(limit: o.cacheLimit)

    var failed = 0, cached = 0, degraded = 0
    for i in 0..<count {
        if status[i] == 2 { failed += 1 }
        if fromCache[i] { cached += 1 }
        if noPicture[i] { degraded += 1 }
    }
    let wall = Int(now() - start)
    output.emit("{\"type\":\"done\",\"clips\":\(count - failed),\"failed\":\(failed),\"cached\":\(cached),\"wallMs\":\(wall),\"degraded\":\(degraded)}")
    trace.flush()
    if !trace.totals.isEmpty { log("totals " + trace.totals.sorted { $0.value > $1.value }.map { "\($0.key)=\(Int($0.value))" }.joined(separator: " ")) }
    log("routes \(trace.routes.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")) wall \(wall) ms")
}

let defaultTier0Workers = 12
let defaultTier1Workers = 12
let defaultTier2Workers = 16

signal(SIGPIPE, SIG_IGN)
prepareChildTracking()
signal(SIGTERM) { _ in
    stopChildren()
    _exit(143)
}

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "scan" { watchForClosedOutput() }
switch args.first {
case "version", "--version":
    print(engineVersion)
case "scan":
    scan(parseOptions(Array(args.dropFirst())))
case "debug":
    runDebug(Array(args.dropFirst()))
default:
    usage()
}
