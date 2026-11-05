import Foundation

// The slow route for anything the direct parser or VideoToolbox cannot read: MXF, fragmented files,
// codecs with no system decoder. It needs ffmpeg on the machine and costs one process per step.
// ffmpeg is optional. Without it a clip that needs it gets a plain reason, never a crash.

private func findTool(_ name: String) -> String? {
    if ProcessInfo.processInfo.environment["ENGINE_TEST_NO_FFMPEG"] != nil { return nil }
    // Premiere starts the engine with a short PATH, so the usual install folders are named here.
    var dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"]
    if let p = ProcessInfo.processInfo.environment["PATH"] { dirs += p.split(separator: ":").map(String.init) }
    return dirs.map { "\($0)/\(name)" }.first { access($0, X_OK) == 0 }
}

let ffprobePath = findTool("ffprobe")
let ffmpegPath = findTool("ffmpeg")

extension Array where Element == String {
    fileprivate func withCStrings<R>(_ body: ([UnsafeMutablePointer<CChar>?]) -> R) -> R {
        var c: [UnsafeMutablePointer<CChar>?] = map { strdup($0) }
        c.append(nil)
        defer { c.forEach { free($0) } }
        return body(c)
    }
}

/// A process per clip adds up, and a small Mac must stay usable, so only so many run at once.
private let toolSlots = max(2, min(8, ProcessInfo.processInfo.activeProcessorCount / 2))
private let toolGate = DispatchSemaphore(value: toolSlots)

/// Tools still running, so a stopped engine takes them with it. Fixed storage: a signal handler reads it.
private let childSlots: UnsafeMutablePointer<pid_t> = {
    let p = UnsafeMutablePointer<pid_t>.allocate(capacity: 16)
    p.initialize(repeating: 0, count: 16)
    return p
}()

private let slotLock = NSLock()

/// Which thread started each child, so a stuck clip's ffmpeg can be stopped on its own.
private let childThreads: UnsafeMutablePointer<UInt32> = {
    let p = UnsafeMutablePointer<UInt32>.allocate(capacity: 16)
    p.initialize(repeating: 0, count: 16)
    return p
}()

func currentThreadID() -> UInt32 { pthread_mach_thread_np(pthread_self()) }

/// Stops the tool a given thread is running, if any.
func stopChild(ofThread thread: UInt32) {
    slotLock.lock()
    defer { slotLock.unlock() }
    for i in 0..<16 where childSlots[i] > 0 && childThreads[i] == thread { kill(childSlots[i], SIGKILL) }
}

/// Must run before a signal handler can, so the handler never builds `childSlots` itself.
func prepareChildTracking() { _ = childSlots }

/// Safe inside a signal handler: reads fixed memory and calls kill.
func stopChildren() {
    for i in 0..<16 where childSlots[i] > 0 { kill(childSlots[i], SIGKILL) }
}

/// A tool that hangs costs 30 s a clip, so a few in a row stop the slow route for the rest of the run.
private let hangsBeforeGivingUp = 3
private let hangLock = NSLock()
private var hangsInARow = 0
private var toolsHung: Bool {
    hangLock.lock()
    defer { hangLock.unlock() }
    return hangsInARow >= hangsBeforeGivingUp
}

/// Runs a tool and returns stdout, or nil on failure or timeout.
private func capture(_ args: [String], timeout: Double = 30) -> Data? {
    toolGate.wait()
    defer { toolGate.signal() }
    guard !toolsHung else { return nil }
    var fds: [Int32] = [0, 0]
    guard pipe(&fds) == 0 else { return nil }
    _ = fcntl(fds[0], F_SETFD, FD_CLOEXEC)
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_adddup2(&actions, fds[1], 1)
    posix_spawn_file_actions_addclose(&actions, fds[1])
    posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    var pid: pid_t = 0
    trace.route("tool-run")
    let rc = args.withCStrings { c in posix_spawn(&pid, args[0], &actions, nil, c, environ) }
    close(fds[1])
    guard rc == 0 else {
        close(fds[0])
        return nil
    }
    var slot = -1
    slotLock.lock()
    for i in 0..<16 where childSlots[i] == 0 {
        childSlots[i] = pid
        childThreads[i] = currentThreadID()
        slot = i
        break
    }
    slotLock.unlock()
    defer {
        slotLock.lock()
        if slot >= 0 { childSlots[slot] = 0 }
        slotLock.unlock()
    }
    var out = Data()
    var chunk = [UInt8](repeating: 0, count: 1 << 18)
    let deadline = Date().addingTimeInterval(timeout)
    var timedOut = false
    while true {
        var p = pollfd(fd: fds[0], events: Int16(POLLIN), revents: 0)
        let left = deadline.timeIntervalSinceNow
        if left <= 0 {
            timedOut = true
            break
        }
        let ready = poll(&p, 1, Int32(min(left, 1) * 1000))
        if ready < 0, errno == EINTR { continue }
        if ready == 0 { continue }
        let n = read(fds[0], &chunk, chunk.count)
        if n <= 0 { break }
        out.append(contentsOf: chunk[0..<n])
    }
    close(fds[0])
    if timedOut { kill(pid, SIGKILL) }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) < 0, errno == EINTR {}
    hangLock.lock()
    hangsInARow = timedOut ? hangsInARow + 1 : 0
    hangLock.unlock()
    return !timedOut && status == 0 ? out : nil
}

private func parsePixFmt(_ pf: String?) -> (Int?, String?) {
    guard let pf else { return (nil, nil) }
    let map: [(String, String)] = [("420", "420"), ("422", "422"), ("444", "444")]
    var chroma = map.first { pf.contains($0.0) }?.1
    if pf.hasPrefix("nv12") || pf.hasPrefix("p010") { chroma = "420" }
    var depth: Int? = 8
    if pf.hasPrefix("p010") { depth = 10 }
    for d in [9, 10, 12, 14, 16] where pf.contains("p\(d)") { depth = d }
    return (depth, chroma)
}

/// The panel looks for the words "ffmpeg not found", so they stay in the sentence.
private func needsFFmpegMessage(path: String) -> String {
    let ext = (path as NSString).pathExtension.uppercased()
    let what = ext.isEmpty || ["MP4", "MOV", "M4V"].contains(ext) ? "This clip needs" : "\(ext) files need"
    return "\(what) ffmpeg (ffmpeg not found on this Mac). Most MP4 and MOV clips work without it."
}

func fallbackTier0(path: String, size: Int64, mtime: Double, reason: String) throws -> Tier0Result {
    // ffmpeg doesn't read these either, so sending people to install it would waste their time.
    let ext = (path as NSString).pathExtension.lowercased()
    if ["r3d", "braw"].contains(ext) { throw MP4Error.unsupported("\(ext.uppercased()) files aren't supported yet.") }
    guard let tool = ffprobePath else { throw MP4Error.needsFFmpeg(needsFFmpegMessage(path: path)) }
    // A probe that didn't finish says nothing about the file, so this one isn't remembered as a verdict.
    guard let out = capture([tool, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]) else {
        throw MP4Error.io("\(productName) can't read this file, and ffprobe couldn't either (\(reason)).")
    }
    guard let root = try? JSONSerialization.jsonObject(with: out) as? [String: Any],
          let streams = root["streams"] as? [[String: Any]],
          let v = streams.first(where: {
              $0["codec_type"] as? String == "video" && ($0["disposition"] as? [String: Any])?["attached_pic"] as? Int != 1
          }) else {
        throw MP4Error.unsupported("\(productName) can't read this file, and neither can ffmpeg (\(reason)).")
    }
    let format = root["format"] as? [String: Any] ?? [:]
    let formatTags = format["tags"] as? [String: Any] ?? [:]
    let videoTags = v["tags"] as? [String: Any] ?? [:]
    let duration = Double(format["duration"] as? String ?? "") ?? Double(v["duration"] as? String ?? "") ?? 0

    var rotation = 0
    for sd in v["side_data_list"] as? [[String: Any]] ?? [] {
        if let r = sd["rotation"] as? Double ?? (sd["rotation"] as? Int).map(Double.init) {
            rotation = ((Int(-r) % 360) + 360) % 360
        }
    }
    let codedW = v["width"] as? Int ?? 0, codedH = v["height"] as? Int ?? 0
    var w = codedW, h = codedH
    if rotation == 90 || rotation == 270 { swap(&w, &h) }

    var fps: Double?
    if let rate = v["avg_frame_rate"] as? String {
        let p = rate.split(separator: "/").compactMap { Double($0) }
        if p.count == 2, p[1] > 0 { fps = p[0] / p[1] }
    }
    let (depth, chroma) = parsePixFmt(v["pix_fmt"] as? String)
    let info = CodecInfo(codec: v["codec_name"] as? String ?? "unknown", bitDepth: depth, chroma: chroma)
    let audio = streams.filter { $0["codec_type"] as? String == "audio" }
    let channels = audio.compactMap { $0["channels"] as? Int }.reduce(0, +)

    var meta = Embedded()
    // Sony's XML beside the clip, or the copy Sony keeps near the start of an MXF.
    let beside = readSidecar(clipPath: path)
    let side = beside ?? leadingSidecar(path: path)
    if let date = (formatTags["com.apple.quicktime.creationdate"] as? String).flatMap(isoDate) {
        (meta.created, meta.createdSource) = (date, .camera)
    } else if let date = ["creation_time", "modification_date"].lazy.compactMap({ (formatTags[$0] as? String).flatMap(isoDate) }).first {
        // The container's time, UTC. MXF has only the time the file was last written, which on Sony cameras is when it was shot.
        (meta.created, meta.createdSource) = (date, .container)
    }
    meta.timecode = side?.timecode ?? (videoTags["timecode"] as? String) ?? (formatTags["timecode"] as? String)
    (meta.make, meta.model) = writerAsCamera(company: formatTags["company_name"] as? String, product: formatTags["product_name"] as? String)
    applySidecar(side, to: &meta)
    preferNameDate(&meta, name: (path as NSString).lastPathComponent)
    // HLG and PQ, as ffprobe names them, so the colour can say it wasn't converted.
    let transfer: String? = ["arib-std-b67": "hlg", "smpte2084": "pq"][v["color_transfer"] as? String ?? ""]
    meta.gamma = side?.gamma ?? transfer

    var plan = ClipPlan()
    plan.fallback = true
    plan.durationS = duration
    plan.rotation = rotation
    plan.width = codedW
    plan.height = codedH
    plan.hasAudio = !audio.isEmpty
    plan.audioTracks = min(audio.count, maxAudioTracks)
    plan.audioStreams = plan.audioTracks
    plan.bitDepth = depth
    plan.formatName = info.displayName
    plan.color = colorPlan(gamma: meta.gamma, primaries: side?.primaries, rtmd: nil)
    let before = colorPlan(gamma: beside?.gamma ?? transfer, primaries: beside?.primaries, rtmd: nil)
    let mbps = duration > 0 ? Double(size) * 8 / duration / 1e6 : nil
    let fields = tier0Fields(path: path, size: size, duration: duration, fps: fps, w: w, h: h, rotation: rotation,
                             info: info, allIntra: nil, mbps: mbps, hasAudio: !audio.isEmpty,
                             channels: channels > 0 ? channels : nil, meta: meta, keyframe: nil, motion: nil,
                             colorNote: plan.color.note)
    return Tier0Result(fields: fields, plan: plan, size: size, mtime: mtime, colorBefore: before)
}

/// MXF names the program that wrote it, which for a camera is often its maker and a module name, such as Sony's "Mem", and
/// for an export is the editing program. Only a maker and model that name a camera are kept. Programs are matched as whole
/// words, so a Blackmagic camera keeps its name while DaVinci Resolve, from the same maker, names none.
func writerAsCamera(company: String?, product: String?) -> (String?, String?) {
    let c = company?.trimmingCharacters(in: .whitespaces), p = product?.trimmingCharacters(in: .whitespaces)
    let words = ((c ?? "") + " " + (p ?? "")).lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    func says(_ phrase: String) -> Bool {
        let want = phrase.split(separator: " ").map(String.init)
        guard want.count <= words.count else { return false }
        return (0...(words.count - want.count)).contains { at in (0..<want.count).allSatisfy { words[at + $0] == want[$0] } }
    }
    let programs = ["adobe", "media encoder", "premiere", "after effects", "resolve", "avid", "media composer", "compressor",
                    "final cut", "ffmpeg", "libavformat", "telestream", "episode", "vantage", "harmonic", "grass valley", "edius",
                    "omneon", "mog", "opencube", "bmx", "mxflib"]
    // ffmpeg's library signs itself Lavf with its version run into the word, such as Lavf60.16.100.
    if programs.contains(where: says) || words.contains(where: { $0.hasPrefix("lavf") }) { return (nil, nil) }
    let maker = c?.isEmpty == false ? c : nil
    // Sony's cameras call their recording module "Mem": that's no model.
    guard let p, !p.isEmpty, p != "Mem" else { return (maker, nil) }
    return (maker, p)
}

/// Sony keeps a copy of the clip's XML in the header of its MXF files: 10 KB in on most, 445 KB in on one FX6 clip here.
func leadingSidecar(path: String) -> Sidecar? {
    guard let f = try? MediaFile(path: path), let b = try? f.read(at: 0, count: Int(min(f.size, 1 << 20))) else { return nil }
    return embeddedSidecar(b.bytes)
}

/// One frame through an ffmpeg process, rebuilt into the layout VideoToolbox gives.
func fallbackFrame<T>(path: String, plan: ClipPlan, body: (FrameView) -> T) -> T? {
    guard let tool = ffmpegPath, plan.width > 1, plan.height > 1 else { return nil }
    let w = plan.width, h = plan.height
    let t = max(0, plan.durationS / 2)
    guard let raw = capture([tool, "-v", "error", "-nostdin", "-noautorotate", "-ss", String(format: "%.3f", t), "-i", path,
                             "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=\(w):\(h)", "-f", "rawvideo", "-pix_fmt", "yuv420p10le", "-"]) else { return nil }
    let cw = (w + 1) / 2, ch = (h + 1) / 2
    let expect = (w * h + 2 * cw * ch) * 2
    guard raw.count == expect else { return nil }
    var y = [UInt16](repeating: 0, count: w * h)
    var uv = [UInt16](repeating: 0, count: cw * ch * 2)
    raw.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
        let s = p.bindMemory(to: UInt16.self)
        for i in 0..<(w * h) { y[i] = s[i] << 6 }
        let u = w * h, v = u + cw * ch
        for i in 0..<(cw * ch) {
            uv[i * 2] = s[u + i] << 6
            uv[i * 2 + 1] = s[v + i] << 6
        }
    }
    return y.withUnsafeBufferPointer { yp in
        uv.withUnsafeBufferPointer { up in
            body(FrameView(y: yp.baseAddress!, yStride: w, width: w, height: h, uv: up.baseAddress!, uvStride: cw * 2))
        }
    }
}

/// One moment as BGRA at the given size, for Tier 2, through an ffmpeg process. ffmpeg rotates nothing here, like the decoder.
func fallbackImage(path: String, at time: Double, width: Int, height: Int) -> Data? {
    guard let tool = ffmpegPath else { return nil }
    guard let raw = capture([tool, "-v", "error", "-nostdin", "-noautorotate", "-ss", String(format: "%.3f", max(0, time)), "-i", path,
                             "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=\(width):\(height)", "-f", "rawvideo", "-pix_fmt", "bgra", "-"]),
          raw.count == width * height * 4 else { return nil }
    return raw
}

/// One frame for a strip through an ffmpeg process: the keyframe at or before `time`, turned upright and cropped from the centre
/// to `width` by `height`, as BGRA.
func fallbackStripFrame(path: String, at time: Double, width: Int, height: Int, timeout: Double) -> Data? {
    guard let tool = ffmpegPath else { return nil }
    guard let raw = capture([tool, "-v", "error", "-nostdin", "-ss", String(format: "%.3f", max(0, time)), "-noaccurate_seek",
                             "-i", path, "-map", "0:v:0", "-frames:v", "1",
                             "-vf", "scale=\(width):\(height):force_original_aspect_ratio=increase,crop=\(width):\(height)",
                             "-f", "rawvideo", "-pix_fmt", "bgra", "-"], timeout: timeout),
          raw.count == width * height * 4 else { return nil }
    return raw
}

/// ffmpeg arguments that put the clip's audio streams, up to `maxAudioTracks`, side by side in one output, so every channel of
/// every track is heard. A second microphone is often a track of its own.
private func allAudio(_ streams: Int) -> [String] {
    guard streams > 1 else { return ["-map", "0:a:0"] }
    let n = min(streams, maxAudioTracks)
    return ["-filter_complex", (0..<n).map { "[0:a:\($0)]" }.joined() + "amerge=inputs=\(n)[a]", "-map", "[a]"]
}

/// Interleaved float samples from a WAV that ffmpeg wrote to a pipe, with its channels and rate. A pipe can't be rewound, so
/// the data size in the header is a placeholder and the samples run to the end.
private func parseWAV(_ d: Data) -> (samples: [Float], channels: Int, rate: Double)? {
    d.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> (samples: [Float], channels: Int, rate: Double)? in
        guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return nil }
        let b = Bytes(base: base, count: raw.count)
        func le16(_ o: Int) -> Int { Int(b.u8(o)) | Int(b.u8(o + 1)) << 8 }
        func le32(_ o: Int) -> Int { le16(o) | le16(o + 2) << 16 }
        guard b.count >= 12, b.u32(0) == fourCC("RIFF"), b.u32(8) == fourCC("WAVE") else { return nil }
        var at = 12, channels = 0, rate = 0, bits = 0
        while b.valid(at, 8) {
            let id = b.u32(at), size = le32(at + 4)
            if id == fourCC("fmt "), b.valid(at + 8, 16) {
                channels = le16(at + 10)
                rate = le32(at + 12)
                bits = le16(at + 22)
            } else if id == fourCC("data") {
                guard channels > 0, rate > 0, bits == 32 else { return nil }
                let count = (b.count - at - 8) / 4
                var out = [Float](repeating: 0, count: count)
                out.withUnsafeMutableBytes { $0.copyMemory(from: UnsafeRawBufferPointer(start: base + at + 8, count: count * 4)) }
                return (out, channels, Double(rate))
            }
            at += 8 + size + (size & 1)
        }
        return nil
    }
}

/// Short windows of a clip's sound, every channel of every track, through ffmpeg. One process reads them all: each window is
/// an input of its own, seeked on its own, and they're joined end to end. That costs about a fifth of a process per window.
/// If it fails, each window gets a process of its own, so one bad window can't cost the others.
private func soundWindows(path: String, _ windows: [(start: Double, span: Double)], streams: Int, rate: Int?) -> [(samples: [Float], channels: Int, rate: Double)] {
    guard let tool = ffmpegPath, !windows.isEmpty else { return [] }
    let n = min(max(streams, 1), maxAudioTracks)
    let output = (rate.map { ["-ar", "\($0)"] } ?? []) + ["-c:a", "pcm_f32le", "-f", "wav", "-"]
    func input(_ w: (start: Double, span: Double)) -> [String] {
        ["-ss", String(format: "%.3f", max(0, w.start)), "-t", String(format: "%.3f", w.span), "-i", path]
    }
    if windows.count > 1 {
        var graph = ""
        for k in windows.indices {
            graph += (0..<n).map { "[\(k):a:\($0)]" }.joined() + (n > 1 ? "amerge=inputs=\(n)" : "anull") + "[w\(k)];"
        }
        graph += windows.indices.map { "[w\($0)]" }.joined() + "concat=n=\(windows.count):v=0:a=1[a]"
        let args = [tool, "-v", "error", "-nostdin"] + windows.flatMap(input) + ["-filter_complex", graph, "-map", "[a]"] + output
        if let wav = capture(args).flatMap(parseWAV) { return [wav] }
    }
    return windows.compactMap { w in
        capture([tool, "-v", "error", "-nostdin"] + input(w) + allAudio(streams) + output).flatMap(parseWAV)
    }
}

/// The three sound windows through ffmpeg, for clips the direct reader can't take: every channel of every track, mixed or the
/// loudest channel on its own, as `MonoPicker` decides.
func fallbackMono(path: String, duration: Double, streams: Int) -> MonoAudio? {
    guard duration > 0, streams > 0 else { return nil }
    let span = min(2.0, duration / 3)
    let windows = [1.0, 3.0, 5.0].map { (start: duration * $0 / 6 - span / 2, span: span) }
    var picker: MonoPicker?
    for wav in soundWindows(path: path, windows, streams: streams, rate: 16000) {
        if picker == nil { picker = MonoPicker(channels: wav.channels, sourceRate: wav.rate) }
        picker!.startWindow()
        for v in wav.samples { picker!.add(Double(v)) }
    }
    return picker?.finish()
}

/// The loudest channel of any track over three short windows through ffmpeg, in dBFS.
func fallbackAudioDb(path: String, duration: Double, streams: Int) -> Double? {
    guard duration > 0, streams > 0 else { return nil }
    let span = min(0.2, duration)
    let windows = (duration <= 1 ? [0] : [1.0, 3.0, 5.0].map { duration * $0 / 6 }).map { (start: $0, span: span) }
    var levels: ChannelLevels?
    for wav in soundWindows(path: path, windows, streams: streams, rate: nil) {
        if levels == nil { levels = ChannelLevels(channels: wav.channels) }
        levels!.startWindow()
        for v in wav.samples { levels!.add(Double(v)) }
    }
    return levels?.db
}
