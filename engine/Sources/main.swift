import Foundation

func log(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

func usage() -> Never {
    log("usage: \(engineName) scan --paths-file <file|-> [--tier 0|1] [--cache <dir>] [--workers <n>] [--no-thumbs]")
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
    var tier = 1
    var cacheDir = NSString(string: "~/Library/Caches/\(bundleId)").expandingTildeInPath
    var workers: Int?
    var thumbs = true
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
            guard let t = Int(value()), t == 0 || t == 1 else { usage() }
            o.tier = t
        case "--cache": o.cacheDir = NSString(string: value()).expandingTildeInPath
        case "--workers":
            guard let n = Int(value()), n > 0, n <= 128 else { usage() }
            o.workers = n
        case "--no-thumbs": o.thumbs = false
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

func runWorkers(_ count: Int, items: Int, _ body: @escaping (Int) -> Void) {
    let lock = NSLock()
    var next = 0
    let group = DispatchGroup()
    for _ in 0..<min(count, max(items, 1)) {
        group.enter()
        let t = Thread {
            while true {
                lock.lock()
                let i = next
                next += 1
                lock.unlock()
                if i >= items { break }
                body(i)
            }
            group.leave()
        }
        t.qualityOfService = .userInitiated
        t.stackSize = 1 << 20
        t.start()
    }
    group.wait()
}

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
func tier1(path: String, plan: ClipPlan, pool: DecoderPool, thumbPath: String?) throws -> (fields: String, timing: Tier1Timing, remember: Bool) {
    var timing = Tier1Timing()
    let file = try MediaFile(path: path)
    var metrics: Metrics?
    var refused: DecodeFailure?
    var t = now()
    if let v = plan.video, !plan.fallback {
        let sample = try file.read(at: v.offset, count: v.size)
        guard sample.count == v.size else { throw MP4Error.truncated }
        timing.read = now() - t
        t = now()
        var decodedAt = 0.0
        let result = pool.decode(v, sample: sample) { frame, hw -> Metrics? in
            decodedAt = now()
            timing.route = hw ? "vt-hw" : "vt-sw"
            return analyze(frame, rotation: plan.rotation, sourceBits: plan.bitDepth, thumbPath: thumbPath)
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
        metrics = fallbackFrame(path: path, plan: slowPlan) { analyze($0, rotation: plan.rotation, sourceBits: plan.bitDepth, thumbPath: thumbPath) } ?? nil
        timing.decode = now() - t
    }
    if metrics == nil { timing.route = "none" }
    timing.thumb = metrics?.thumbMs ?? 0

    t = now()
    var db: Double?
    if plan.hasAudio {
        if let a = plan.audio {
            db = measureAudio(a, file: file)
        }
        if db == nil { db = fallbackAudioDb(path: path, duration: plan.durationS) }
    }
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
    return (out.joined, timing, metrics != nil)
}

let silenceDb = -50.0

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
    let sizes = UnsafeMutablePointer<(Int64, Double)>.allocate(capacity: max(count, 1))
    sizes.initialize(repeating: (0, 0), count: max(count, 1))
    let status = UnsafeMutablePointer<UInt8>.allocate(capacity: max(count, 1)) // 0 pending, 1 ok, 2 failed
    status.initialize(repeating: 0, count: max(count, 1))
    let fromCache = UnsafeMutablePointer<Bool>.allocate(capacity: max(count, 1))
    fromCache.initialize(repeating: false, count: max(count, 1))
    let noPicture = UnsafeMutablePointer<Bool>.allocate(capacity: max(count, 1))
    noPicture.initialize(repeating: false, count: max(count, 1))

    func fail(_ i: Int, _ error: Error, size: Int64 = -1, mtime: Double = 0) {
        status[i] = 2
        var f = Fields()
        f.add("message", "\(error)")
        output.emit("{\"type\":\"error\",\"path\":\(jsonPaths[i]),\(f.joined)}")
        let transient = (error as? MP4Error)?.isTransient ?? true
        if size >= 0, !transient { cache.store(kind: "e", jsonPath: jsonPaths[i], size: size, mtime: mtime, value: f.joined) }
    }

    runWorkers(workers0, items: count) { i in
        let path = paths[i]
        var st = stat()
        guard stat(path, &st) == 0 else {
            fail(i, MP4Error.io(String(cString: strerror(errno))))
            return
        }
        let size = Int64(st.st_size)
        let mtime = Double(st.st_mtimespec.tv_sec) + Double(st.st_mtimespec.tv_nsec) / 1e9
        sizes[i] = (size, mtime)
        if let e = cache.lookup(jsonPaths[i], size: size, mtime: mtime) {
            if let err = e.error {
                status[i] = 2
                output.emit("{\"type\":\"error\",\"path\":\(jsonPaths[i]),\(err)}")
                fromCache[i] = true
                return
            }
            if let fields = e.tier0 {
                status[i] = 1
                fromCache[i] = true
                output.emit(clipLine(tier: 0, path: jsonPaths[i], cached: true, ms: 0, fields: fields))
                return
            }
        }
        let t0 = now()
        do {
            let r = try tier0(path: path)
            let ms = now() - t0
            trace.route(r.plan.fallback ? "tier0-ffprobe" : "tier0-direct")
            trace.row("0\t\(ms)\t\(r.plan.fallback ? "ffprobe" : "direct")\t\(path)")
            plans[i] = r.plan
            status[i] = 1
            output.emit(clipLine(tier: 0, path: jsonPaths[i], cached: false, ms: ms, fields: r.fields))
            cache.store(kind: "0", jsonPath: jsonPaths[i], size: size, mtime: mtime, value: r.fields)
        } catch {
            fail(i, error, size: size, mtime: mtime)
        }
    }

    log(String(format: "tier0 phase %.0f ms", now() - start))
    if o.tier == 1 {
        let pool = DecoderPool(capacity: max(8, workers1 * 2))
        runWorkers(workers1, items: count) { i in
            guard status[i] == 1 else { return }
            let path = paths[i]
            let (size, mtime) = sizes[i]
            let thumb = o.thumbs ? cache.thumbPath(path: path, size: size, mtime: mtime) : nil
            if let e = cache.lookup(jsonPaths[i], size: size, mtime: mtime), let fields = e.tier1 {
                let thumbReady = !o.thumbs || e.noPicture || (e.thumb.map { access($0, R_OK) == 0 } ?? false)
                if thumbReady {
                    if e.noPicture { noPicture[i] = true }
                    output.emit(clipLine(tier: 1, path: jsonPaths[i], cached: true, ms: 0, fields: fields))
                    return
                }
            }
            fromCache[i] = false
            let t0 = now()
            do {
                let plan: ClipPlan
                if let p = plans[i] { plan = p } else { plan = try tier0(path: path).plan }
                let r = try tier1(path: path, plan: plan, pool: pool, thumbPath: thumb)
                let ms = now() - t0
                let tm = r.timing
                trace.route("tier1-" + tm.route)
                trace.row(String(format: "1\t%.2f\t%@\t%.2f\t%.2f\t%.2f\t%.2f\t%.2f\t%@", ms, tm.route, tm.read, tm.decode, tm.analyze, tm.thumb, tm.audio, path))
                output.emit(clipLine(tier: 1, path: jsonPaths[i], cached: false, ms: ms, fields: r.fields))
                if tm.route == "none" { noPicture[i] = true }
                if r.remember { cache.store(kind: "1", jsonPath: jsonPaths[i], size: size, mtime: mtime, value: r.fields) }
            } catch {
                fail(i, error, size: size, mtime: mtime)
            }
            plans[i] = nil
        }
        pool.closeAll()
    }

    var failed = 0, cached = 0, degraded = 0
    for i in 0..<count {
        if status[i] == 2 { failed += 1 }
        if fromCache[i] { cached += 1 }
        if noPicture[i] { degraded += 1 }
    }
    let wall = Int(now() - start)
    output.emit("{\"type\":\"done\",\"clips\":\(count - failed),\"failed\":\(failed),\"cached\":\(cached),\"wallMs\":\(wall),\"degraded\":\(degraded)}")
    trace.flush()
    log("routes \(trace.routes.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")) wall \(wall) ms")
}

let defaultTier0Workers = 12
let defaultTier1Workers = 12

signal(SIGPIPE, SIG_IGN)
prepareChildTracking()
signal(SIGTERM) { _ in
    stopChildren()
    _exit(143)
}

let args = Array(CommandLine.arguments.dropFirst())
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
