import Foundation

/// Everything Tier 1 needs, so a clip is not parsed twice.
struct VideoPlan {
    let offset: Int64
    let size: Int
    let format: UInt32
    let codedWidth: Int
    let codedHeight: Int
    let atoms: [String: Data]
}

enum AudioKind {
    case pcm(bits: Int, float: Bool, bigEndian: Bool, channels: Int)
    case aac(esds: Data, channels: Int)
}

struct AudioWindow {
    let offset: Int64
    let bytes: Int
    /// AAC only: each packet's position within the read and its size.
    let packets: [(at: Int, size: Int)]
    /// Sound windows only: pieces with the same number follow on from each other in the clip.
    var run = 0
}

struct AudioPlan {
    let kind: AudioKind
    let windows: [AudioWindow]
}

struct ClipPlan {
    var video: VideoPlan?
    var audio: AudioPlan?
    var hasAudio = false
    var durationS = 0.0
    var rotation = 0
    var width = 0
    var height = 0
    var fallback = false
    var bitDepth: Int?
    /// Keyframes to look at in Tier 2, in clip order.
    var moments: [VideoPlan] = []
    var rtmd: RtmdPlan?
    /// The file or its sidecar says this is a log curve.
    var isLog = false
    /// Longer sampled windows than `audio`, for telling sounds apart.
    var sound: AudioPlan?
    var audioRate = 0.0
    /// For messages: "H.264 10-bit 4:2:2".
    var formatName = "this format"
}

struct Tier0Result {
    let fields: String
    let plan: ClipPlan
    let size: Int64
    let mtime: Double
}

/// A larger keyframe than this means a corrupt table: 8K ProRes 4444 XQ is about 30 MB.
let maxSampleBytes = 1 << 28

/// 15 windows of 0.2 s track a full read to a median 0.7 dB, p90 3.7 dB, on 392 clips.
let audioWindowCount = 15
let audioWindowSeconds = 0.2

/// Reads rotation from the signs, so a matrix that also scales still counts.
private func rotationOf(_ m: (Int32, Int32, Int32, Int32)) -> Int {
    let (a, b, c, d) = m
    if a == 0, d == 0 {
        if b > 0, c < 0 { return 90 }
        if b < 0, c > 0 { return 270 }
    }
    if b == 0, c == 0, a < 0, d < 0 { return 180 }
    return 0
}

/// Bytes per megapixel across sync samples, and a 0 to 1 spread of sample sizes along the clip.
private func sizeStatistics(_ v: Track, codedPixels: Int, fps: Double) -> (keyframe: Double?, motion: Double?) {
    guard v.sampleCount > 0, codedPixels > 0 else { return (nil, nil) }
    var syncTotal = 0.0
    var syncN = 0
    if let stss = v.stss, stss.count >= 4 {
        for i in 0..<(stss.count / 4) {
            let s = Int(stss.u32(i * 4)) - 1
            guard s >= 0, s < v.sampleCount else { continue }
            syncTotal += Double(v.sampleSize(s))
            syncN += 1
        }
    } else {
        for s in 0..<v.sampleCount { syncTotal += Double(v.sampleSize(s)) }
        syncN = v.sampleCount
    }
    let keyframe = syncN > 0 ? syncTotal / Double(syncN) / (Double(codedPixels) / 1e6) : nil

    // Per-window mean sizes over a window of about 0.5 s. GOP structure averages out, so what is
    // left is the change in coding cost along the clip.
    let window = max(1, Int((fps > 0 ? fps : 25) / 2))
    guard v.sampleCount >= window * 2, v.stszFixed == 0 else { return (keyframe, nil) }
    var sum = 0.0, sumSq = 0.0
    var n = 0
    var s = 0
    while s + window <= v.sampleCount {
        var w = 0.0
        for i in s..<(s + window) { w += Double(v.sizes.u32(i * 4)) }
        sum += w
        sumSq += w * w
        n += 1
        s += window
    }
    guard n >= 2, sum > 0 else { return (keyframe, nil) }
    let mean = sum / Double(n)
    let variance = max(0, sumSq / Double(n) - mean * mean)
    let cv = variance.squareRoot() / mean
    return (keyframe, cv / (cv + 1))
}

private func pcmFormat(_ t: Track) -> (kind: AudioKind, frameBytes: Int)? {
    let e = t.stsdEntry
    let version = e.u16(8)
    var channels = Int(e.u16(16))
    var bits = Int(e.u16(18))
    var float = false
    var big = true
    switch t.format {
    case fourCC("twos"), fourCC("NONE"), fourCC("raw "): big = true
    case fourCC("sowt"): big = false
    case fourCC("in24"): bits = 24
    case fourCC("in32"): bits = 32
    case fourCC("fl32"): bits = 32; float = true
    case fourCC("fl64"): bits = 64; float = true
    case fourCC("lpcm"):
        guard version == 2 else { return nil }
        channels = Int(e.u32(40))
        bits = Int(e.u32(48))
        let flags = e.u32(52)
        float = flags & 1 != 0
        big = flags & 2 != 0
    case fourCC("ipcm"), fourCC("fpcm"):
        float = t.format == fourCC("fpcm")
        for b in BoxIterator(e.sub(28, max(0, e.count - 28))) where b.type == fourCC("pcmC") {
            big = b.body.u8(4) & 1 == 0
            bits = Int(b.body.u8(5))
        }
    default: return nil
    }
    if t.format == fourCC("in24") || t.format == fourCC("in32") || t.format == fourCC("fl32") || t.format == fourCC("fl64") {
        let start = version == 1 ? 44 : 28
        for b in BoxIterator(e.sub(start, max(0, e.count - start))) where b.type == fourCC("wave") {
            for w in BoxIterator(b.body) where w.type == fourCC("enda") { big = w.body.u16(0) == 0 }
        }
    }
    guard channels > 0, [16, 24, 32, 64].contains(bits) else { return nil }
    if bits == 64 && !float { return nil }
    return (.pcm(bits: bits, float: float, bigEndian: big, channels: channels), channels * bits / 8)
}

private func findESDS(_ t: Track) -> Data? {
    let e = t.stsdEntry
    let version = e.u16(8)
    let start = version == 1 ? 44 : (version == 2 ? 64 : 28)
    for b in BoxIterator(e.sub(start, max(0, e.count - start))) {
        if b.type == fourCC("esds") { return b.body.sub(4, max(0, b.body.count - 4)).data }
        if b.type == fourCC("wave") {
            for w in BoxIterator(b.body) where w.type == fourCC("esds") {
                return w.body.sub(4, max(0, w.body.count - 4)).data
            }
        }
    }
    return nil
}

/// Channel configuration from the AudioSpecificConfig inside esds, or nil when it defers to the stream.
private func aacChannels(_ esds: Data) -> Int? {
    let bytes = [UInt8](esds)
    var at = 0
    func length() -> Int? {
        var n = 0
        for _ in 0..<4 {
            guard at < bytes.count else { return nil }
            let b = bytes[at]
            at += 1
            n = n << 7 | Int(b & 0x7f)
            if b & 0x80 == 0 { return n }
        }
        return n
    }
    while at < bytes.count {
        let tag = bytes[at]
        at += 1
        guard let n = length() else { return nil }
        switch tag {
        case 3:
            guard at + 3 <= bytes.count else { return nil }
            let flags = bytes[at + 2]
            at += 3
            if flags & 0x80 != 0 { at += 2 }
            if flags & 0x40 != 0 {
                guard at < bytes.count else { return nil }
                at += 1 + Int(bytes[at])
            }
            if flags & 0x20 != 0 { at += 2 }
        case 4:
            at += 13
        case 5:
            guard n >= 2, at + 1 < bytes.count else { return nil }
            var object = bytes[at] >> 3
            var bit = 5
            func read(_ count: Int) -> Int {
                var v = 0
                for _ in 0..<count {
                    guard (bit >> 3) + at < bytes.count else { return v }
                    v = v << 1 | Int((bytes[at + bit >> 3] >> UInt8(7 - bit & 7)) & 1)
                    bit += 1
                }
                return v
            }
            if object == 31 { object = UInt8(32 + read(6)) }
            if read(4) == 15 { _ = read(24) }
            let config = read(4)
            guard config > 0 else { return nil }
            return config == 7 ? 8 : (config <= 6 ? config : nil)
        default:
            at += n
        }
    }
    return nil
}

func channelCount(_ t: Track) -> Int? {
    if let (kind, _) = pcmFormat(t), case .pcm(_, _, _, let c) = kind { return c }
    if t.format == fourCC("mp4a"), let esds = findESDS(t), let n = aacChannels(esds) { return n }
    let n = Int(t.stsdEntry.u16(16))
    return n > 0 ? n : nil
}

/// Sound classification wants about a second at a time, so each of these windows walks a few chunks in a row.
private let soundWindowCount = 3
private let soundWindowSeconds = 2.0
/// What one clip may read for sound. A real clip uses about a megabyte, and a damaged table can't ask for more than this.
private let soundBudgetBytes = 32 << 20
/// Some cameras store a packet or two per chunk, and each chunk is its own read.
private let soundMaxReads = 48

/// From the sample description, because the track's timescale isn't always the sample rate.
private func sampleRate(_ t: Track) -> Double {
    let fixed = Double(t.stsdEntry.u32(24)) / 65536
    return fixed >= 8000 ? fixed : Double(t.timescale)
}

private func soundPlan(_ t: Track) -> AudioPlan? {
    let duration = t.timescale > 0 ? Double(t.sttsTotal()) / Double(t.timescale) : 0
    guard duration > 0 else { return nil }
    let span = min(soundWindowSeconds, duration / Double(soundWindowCount))
    let starts = (0..<soundWindowCount).map { duration * (Double($0) + 0.5) / Double(soundWindowCount) - span / 2 }
    var pieces: [AudioWindow] = []
    var budget = soundBudgetBytes
    if let (kind, frameBytes) = pcmFormat(t) {
        let singleFrames = t.stszFixed != 0 && (Int(t.stszFixed) == frameBytes || t.stszFixed == 1)
        for start in starts {
            var at = max(0, start), left = min(Int(span * sampleRate(t)) * frameBytes, budget)
            var guardSteps = 0
            while left > 0, guardSteps < 32 {
                guardSteps += 1
                let sample = t.sampleAt(mediaTime: UInt64(at * Double(t.timescale)))
                guard let loc = t.locate(sample) else { break }
                var offset = t.chunkOffset(loc.chunk)
                var bytes: Int
                if singleFrames {
                    offset += Int64(loc.indexInChunk * frameBytes)
                    bytes = (loc.samplesInChunk - loc.indexInChunk) * frameBytes
                } else {
                    guard let o = t.sampleOffset(sample) else { break }
                    offset = o
                    bytes = 0
                    var s = sample, run = loc.samplesInChunk - loc.indexInChunk
                    while run > 0, bytes < left, s < t.sampleCount {
                        bytes += t.sampleSize(s)
                        s += 1
                        run -= 1
                    }
                }
                bytes = min(bytes, left)
                bytes -= bytes % frameBytes
                guard bytes > 0 else { break }
                pieces.append(AudioWindow(offset: offset, bytes: bytes, packets: []))
                left -= bytes
                budget -= bytes
                at += Double(bytes / frameBytes) / Double(t.timescale)
            }
        }
        return pieces.isEmpty ? nil : AudioPlan(kind: kind, windows: pieces)
    }
    if t.format == fourCC("mp4a"), let esds = findESDS(t) {
        let channels = channelCount(t) ?? 1
        for (run, start) in starts.enumerated() {
            var sample = t.sampleAt(mediaTime: UInt64(max(0, start) * Double(t.timescale)))
            let last = min(sample + Int(span * 48), t.sampleCount)     // 48 packets a second covers AAC at 48 kHz
            var reads = 0
            while sample < last, reads < soundMaxReads {
                reads += 1
                guard let loc = t.locate(sample), let off = t.sampleOffset(sample) else { break }
                var packets: [(at: Int, size: Int)] = []
                var end = 0
                let inChunk = min(loc.samplesInChunk - loc.indexInChunk, last - sample)
                for s in sample..<(sample + inChunk) {
                    guard let o = t.sampleOffset(s) else { break }
                    let at = Int(o - off), size = t.sampleSize(s)
                    guard at >= 0, at + size <= 1 << 21 else { break }
                    packets.append((at, size))
                    end = at + size
                }
                sample += max(1, inChunk)
                if !packets.isEmpty, end <= budget {
                    pieces.append(AudioWindow(offset: off, bytes: end, packets: packets, run: run))
                    budget -= end
                }
            }
        }
        return pieces.isEmpty ? nil : AudioPlan(kind: .aac(esds: esds, channels: channels), windows: pieces)
    }
    return nil
}

private func audioPlan(_ t: Track) -> AudioPlan? {
    let duration = t.timescale > 0 ? Double(t.sttsTotal()) / Double(t.timescale) : 0
    guard duration > 0 else { return nil }

    func windowTimes(_ span: Double) -> [Double] {
        if duration <= span * Double(audioWindowCount) {
            return [0]
        }
        return (0..<audioWindowCount).map { duration * (Double($0) + 0.5) / Double(audioWindowCount) }
    }

    if let (kind, frameBytes) = pcmFormat(t) {
        let singleFrames = t.stszFixed != 0 && (Int(t.stszFixed) == frameBytes || t.stszFixed == 1)
        let rate = Double(t.timescale)
        let span = duration <= audioWindowSeconds * Double(audioWindowCount) ? duration : audioWindowSeconds
        var windows: [AudioWindow] = []
        for time in windowTimes(audioWindowSeconds) {
            let want = max(frameBytes, Int(span * rate) * frameBytes)
            let sample = t.sampleAt(mediaTime: UInt64(time * Double(t.timescale)))
            guard let loc = t.locate(sample) else { continue }
            var off = t.chunkOffset(loc.chunk)
            var avail: Int
            if singleFrames {
                off += Int64(loc.indexInChunk * frameBytes)
                avail = (loc.samplesInChunk - loc.indexInChunk) * frameBytes
            } else {
                guard let o = t.sampleOffset(sample) else { continue }
                off = o
                avail = 0
                var s = sample
                var left = loc.samplesInChunk - loc.indexInChunk
                while left > 0, avail < want, s < t.sampleCount {
                    avail += t.sampleSize(s)
                    s += 1
                    left -= 1
                }
            }
            avail = min(avail, want)
            avail -= avail % frameBytes
            if avail > 0 { windows.append(AudioWindow(offset: off, bytes: avail, packets: [])) }
        }
        return windows.isEmpty ? nil : AudioPlan(kind: kind, windows: windows)
    }

    if t.format == fourCC("mp4a"), let esds = findESDS(t) {
        let channels = channelCount(t) ?? 1
        var windows: [AudioWindow] = []
        for time in windowTimes(0.2) {
            let sample = t.sampleAt(mediaTime: UInt64(time * Double(t.timescale)))
            // Web muxers put one or two packets in a chunk, so walk samples rather than chunks.
            // The read spans any video interleaved between them, capped so a window stays cheap.
            guard let off = t.sampleOffset(sample) else { continue }
            var packets: [(at: Int, size: Int)] = []
            var end = 0
            for s in sample..<min(sample + 12, t.sampleCount) {
                guard let o = t.sampleOffset(s) else { break }
                let at = Int(o - off), size = t.sampleSize(s)
                guard at >= 0, at + size <= 1 << 21 else { break }
                packets.append((at, size))
                end = at + size
            }
            if packets.count >= 4 { windows.append(AudioWindow(offset: off, bytes: end, packets: packets)) }
        }
        return windows.isEmpty ? nil : AudioPlan(kind: .aac(esds: esds, channels: channels), windows: windows)
    }
    return nil
}

func tier0(path: String) throws -> Tier0Result {
    let f = try MediaFile(path: path)
    let m: Movie
    do {
        m = try loadMovie(f)
    } catch MP4Error.io(let msg) {
        throw MP4Error.io(msg)
    } catch {
        return try fallbackTier0(path: path, size: f.size, mtime: f.mtime, reason: "\(error)")
    }
    guard let v = m.video, !m.fragmented, v.timescale > 0 else {
        return try fallbackTier0(path: path, size: f.size, mtime: f.mtime,
                                 reason: m.fragmented ? "fragmented" : "no readable video track")
    }

    let rotation = rotationOf(v.matrix)
    let codedW = Int(v.stsdEntry.u16(24)), codedH = Int(v.stsdEntry.u16(26))
    var w = v.tkhdWidth > 0 ? Int(v.tkhdWidth.rounded()) : codedW
    var h = v.tkhdHeight > 0 ? Int(v.tkhdHeight.rounded()) : codedH
    if rotation == 90 || rotation == 270 { swap(&w, &h) }

    let mediaTicks = v.sttsTotal()
    let videoS = Double(mediaTicks) / Double(v.timescale)
    let duration = m.mvhdTimescale > 0 && m.mvhdDuration > 0 ? Double(m.mvhdDuration) / Double(m.mvhdTimescale) : videoS
    let fps = videoS > 0 ? Double(v.sampleCount) / videoS : nil
    let info = codecInfo(v)
    let (keyframe, motion) = sizeStatistics(v, codedPixels: codedW * codedH, fps: fps ?? 0)
    let allIntra = v.stss == nil || v.syncCount == v.sampleCount

    let audios = m.audio
    let channels = audios.compactMap(channelCount).reduce(0, +)

    var meta = embeddedMetadata(m)
    let side = readSidecar(clipPath: path)
    meta.timecode = side?.timecode ?? trackTimecode(m, f)
    meta.gamma = side?.gamma ?? transferGamma(v)
    meta.lens = side?.lens ?? meta.lens
    meta.make = side?.make ?? meta.make
    meta.model = side?.model ?? meta.model
    meta.created = side?.created ?? meta.created

    var plan = ClipPlan()
    plan.durationS = duration
    plan.rotation = rotation
    plan.width = w
    plan.height = h
    plan.hasAudio = !audios.isEmpty
    plan.bitDepth = info.bitDepth
    plan.formatName = info.displayName
    plan.isLog = meta.gamma?.lowercased().contains("log") ?? false
    let atoms = decoderAtoms(v)
    func videoPlan(atTicks ticks: UInt64) -> VideoPlan? {
        let sync = v.nearestSync(to: v.sampleAt(mediaTime: ticks))
        guard let off = v.sampleOffset(sync), v.sampleSize(sync) > 0, v.sampleSize(sync) < maxSampleBytes,
              codedW > 0, codedH > 0 else { return nil }
        return VideoPlan(offset: off, size: v.sampleSize(sync), format: v.format, codedWidth: codedW, codedHeight: codedH, atoms: atoms)
    }
    plan.video = videoPlan(atTicks: mediaTicks / 2)
    // Three moments spread through the clip. A short clip with one keyframe may give only one.
    for sixths in [1, 3, 5] as [UInt64] {
        guard let m = videoPlan(atTicks: mediaTicks / 6 * sixths), !plan.moments.contains(where: { $0.offset == m.offset }) else { continue }
        plan.moments.append(m)
    }
    // Level is read from the widest track, which is the one ffmpeg would pick by default.
    if let best = audios.enumerated().max(by: {
        (channelCount($0.element) ?? 0, -$0.offset) < (channelCount($1.element) ?? 0, -$1.offset)
    })?.element {
        plan.audio = audioPlan(best)
        plan.sound = soundPlan(best)
        plan.audioRate = sampleRate(best)
    }
    plan.rtmd = rtmdPlan(m)

    let mbps = duration > 0 ? Double(f.size) * 8 / duration / 1e6 : nil
    let fields = tier0Fields(path: path, size: f.size, duration: duration, fps: fps, w: w, h: h, rotation: rotation,
                             info: info, allIntra: allIntra, mbps: mbps, hasAudio: !audios.isEmpty,
                             channels: channels > 0 ? channels : nil, meta: meta, keyframe: keyframe, motion: motion)
    return Tier0Result(fields: fields, plan: plan, size: f.size, mtime: f.mtime)
}

func tier0Fields(path: String, size: Int64, duration: Double, fps: Double?, w: Int, h: Int, rotation: Int, info: CodecInfo,
                 allIntra: Bool?, mbps: Double?, hasAudio: Bool, channels: Int?, meta: Embedded,
                 keyframe: Double?, motion: Double?) -> String {
    var out = Fields()
    out.add("name", (path as NSString).lastPathComponent)
    out.add("sizeBytes", size)
    out.add("durationS", duration)
    out.add("fps", fps)
    out.add("width", w)
    out.add("height", h)
    out.add("rotation", rotation)
    out.add("codec", info.codec)
    out.add("bitDepth", info.bitDepth)
    out.add("chroma", info.chroma)
    out.add("allIntra", allIntra)
    out.add("mbps", mbps, 2)
    out.add("hasAudio", hasAudio)
    out.add("audioChannels", channels)
    out.add("createdAt", meta.created)
    out.add("timecode", meta.timecode)
    let camera = [meta.make, meta.model].compactMap { $0 }.joined(separator: " ")
    out.add("camera", camera.isEmpty ? nil : camera)
    out.add("lens", meta.lens)
    out.add("gamma", meta.gamma)
    out.add("isLog", meta.gamma.map { $0.lowercased().contains("log") })
    out.add("gpsLat", meta.lat, 6)
    out.add("gpsLon", meta.lon, 6)
    out.add("keyframeBytesMean", keyframe, 0)
    out.add("motionProxy", motion, 4)
    return out.joined
}
