import AudioToolbox
import Foundation

/// RMS over the sampled windows, in dBFS, comparable to ffmpeg volumedetect mean_volume.
struct Level {
    var energy = 0.0
    var samples = 0
    mutating func add(_ v: Double) {
        energy += v * v
        samples += 1
    }
    var db: Double? {
        guard samples > 0 else { return nil }
        let mean = energy / Double(samples)
        return mean > 1e-12 ? max(-120, 10 * log10(mean)) : -120
    }
}

/// A level per channel, so a quiet channel can't hide a loud one. Fed interleaved samples, a window at a time. Past 64 channels
/// they share, which only a damaged file asks for.
struct ChannelLevels {
    private var levels: [Level]
    private let channels: Int
    private var at = 0
    init(channels: Int) {
        self.channels = max(1, channels)
        levels = Array(repeating: Level(), count: min(self.channels, 64))
    }
    /// Windows hold whole frames, but one cut short by the end of a file mustn't shift the channels of the next.
    mutating func startWindow() { at = 0 }
    mutating func add(_ v: Double) {
        levels[at % levels.count].add(v)
        at += 1
        if at == channels { at = 0 }
    }
    /// The loudest channel, in dBFS.
    var db: Double? { levels.compactMap(\.db).max() }
}

@inline(__always)
func forEachPCM(_ b: Bytes, bits: Int, float: Bool, big: Bool, _ add: (Double) -> Void) {
    let width = bits / 8
    let n = b.count / width
    let p = UnsafeRawPointer(b.base)
    switch (bits, float) {
    case (16, _):
        for i in 0..<n {
            let v = p.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)
            add(Double(big ? Int16(bigEndian: v) : Int16(littleEndian: v)) / 32768)
        }
    case (24, _):
        for i in 0..<n {
            let a = b.base[i * 3], c = b.base[i * 3 + 1], d = b.base[i * 3 + 2]
            let hi = big ? a : d, lo = big ? d : a
            let v = Int32(truncatingIfNeeded: UInt32(hi) << 24 | UInt32(c) << 16 | UInt32(lo) << 8) >> 8
            add(Double(v) / 8_388_608)
        }
    case (32, false):
        for i in 0..<n {
            let v = p.loadUnaligned(fromByteOffset: i * 4, as: Int32.self)
            add(Double(big ? Int32(bigEndian: v) : Int32(littleEndian: v)) / 2_147_483_648)
        }
    case (32, true):
        for i in 0..<n {
            let v = p.loadUnaligned(fromByteOffset: i * 4, as: UInt32.self)
            add(Double(Float(bitPattern: big ? UInt32(bigEndian: v) : UInt32(littleEndian: v))))
        }
    case (64, true):
        for i in 0..<n {
            let v = p.loadUnaligned(fromByteOffset: i * 8, as: UInt64.self)
            add(Double(bitPattern: big ? UInt64(bigEndian: v) : UInt64(littleEndian: v)))
        }
    default: break
    }
}

private final class PacketFeed {
    let base: UnsafePointer<UInt8>
    let packets: [(at: Int, size: Int)]
    var index = 0
    var description = AudioStreamPacketDescription()
    init(base: UnsafePointer<UInt8>, packets: [(at: Int, size: Int)]) {
        self.base = base
        self.packets = packets
    }
}

private let feedCallback: AudioConverterComplexInputDataProc = { _, ioPackets, ioData, outDesc, user in
    let feed = Unmanaged<PacketFeed>.fromOpaque(user!).takeUnretainedValue()
    guard feed.index < feed.packets.count else {
        ioPackets.pointee = 0
        ioData.pointee.mBuffers.mData = nil
        ioData.pointee.mBuffers.mDataByteSize = 0
        return 1
    }
    let (at, size) = feed.packets[feed.index]
    ioPackets.pointee = 1
    ioData.pointee.mNumberBuffers = 1
    ioData.pointee.mBuffers.mData = UnsafeMutableRawPointer(mutating: feed.base + at)
    ioData.pointee.mBuffers.mDataByteSize = UInt32(size)
    feed.description = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(size))
    if let outDesc {
        withUnsafeMutablePointer(to: &feed.description) { outDesc.pointee = $0 }
    }
    feed.index += 1
    return 0
}

/// Decodes short AAC runs with one converter. The first packets of a window only prime the overlap, so their output is dropped.
/// `sink` gets whole frames, interleaved, with the number of channels.
private func decodeAAC(esds: Data, windows: [(ReadBuffer, [(at: Int, size: Int)])], sink: (UnsafeBufferPointer<Float>, Int) -> Void) -> Bool {
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    let got = esds.withUnsafeBytes {
        AudioFormatGetProperty(kAudioFormatProperty_ASBDFromESDS, UInt32(esds.count), $0.baseAddress, &size, &asbd)
    }
    guard got == 0, asbd.mChannelsPerFrame > 0, asbd.mSampleRate > 0 else { return false }
    var out = AudioStreamBasicDescription(mSampleRate: asbd.mSampleRate, mFormatID: kAudioFormatLinearPCM,
                                          mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                                          mBytesPerPacket: 4 * asbd.mChannelsPerFrame, mFramesPerPacket: 1,
                                          mBytesPerFrame: 4 * asbd.mChannelsPerFrame,
                                          mChannelsPerFrame: asbd.mChannelsPerFrame, mBitsPerChannel: 32, mReserved: 0)
    var conv: AudioConverterRef?
    guard AudioConverterNew(&asbd, &out, &conv) == 0, let conv else { return false }
    defer { AudioConverterDispose(conv) }
    _ = esds.withUnsafeBytes {
        AudioConverterSetProperty(conv, kAudioConverterDecompressionMagicCookie, UInt32(esds.count), $0.baseAddress!)
    }
    let channels = Int(asbd.mChannelsPerFrame)
    let frames = 2048
    var pcm = [Float](repeating: 0, count: frames * channels)
    var added = false
    for (data, packets) in windows {
        AudioConverterReset(conv)
        let feed = PacketFeed(base: data.view, packets: packets)
        let user = Unmanaged.passUnretained(feed).toOpaque()
        var drop = 2048
        while true {
            var count = UInt32(frames)
            var status: OSStatus = 0
            var produced = 0
            pcm.withUnsafeMutableBytes { raw in
                var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: UInt32(channels),
                                                                                    mDataByteSize: UInt32(raw.count),
                                                                                    mData: raw.baseAddress))
                status = AudioConverterFillComplexBuffer(conv, feedCallback, user, &count, &list, nil)
                produced = Int(count)
            }
            if produced == 0 { break }
            let skip = min(drop, produced)
            drop -= skip
            if produced > skip {
                pcm.withUnsafeBufferPointer { p in
                    sink(UnsafeBufferPointer(rebasing: p[(skip * channels)..<(produced * channels)]), channels)
                }
                added = true
            }
            if status != 0 { break }
        }
    }
    return added
}

/// Reads AAC pieces and joins those of one run, in order, so the decoder gets each run as one stream: it needs its first
/// packets to settle, and a piece can be a single packet. A piece that can't be read is left out of its run.
private func joinRuns(_ windows: [AudioWindow], file: MediaFile) -> [(ReadBuffer, [(at: Int, size: Int)])] {
    var runs: [Int: (bytes: [UInt8], packets: [(at: Int, size: Int)])] = [:]
    for w in windows {
        guard let b = try? file.read(at: w.offset, count: w.bytes), b.count == w.bytes else { continue }
        var whole = runs[w.run] ?? ([], [])
        let base = whole.bytes.count
        whole.bytes.append(contentsOf: UnsafeBufferPointer(start: b.view, count: b.count))
        whole.packets += w.packets.map { ($0.at + base, $0.size) }
        runs[w.run] = whole
    }
    return runs.sorted { $0.key < $1.key }.compactMap { _, r in
        guard !r.bytes.isEmpty, let raw = malloc(r.bytes.count) else { return nil }
        r.bytes.withUnsafeBytes { raw.copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
        return (ReadBuffer(raw: raw, skip: 0, count: r.bytes.count), r.packets)
    }
}

/// The level of the loudest channel in one track's sampled windows, in dBFS.
func measureAudio(_ plan: AudioPlan, file: MediaFile) -> Double? {
    switch plan.kind {
    case .pcm(let bits, let float, let big, let channels):
        var levels = ChannelLevels(channels: channels)
        for w in plan.windows {
            guard let b = try? file.read(at: w.offset, count: w.bytes) else { continue }
            levels.startWindow()
            forEachPCM(b.bytes, bits: bits, float: float, big: big) { levels.add($0) }
        }
        return levels.db
    case .aac(let esds, _):
        let reads = joinRuns(plan.windows, file: file)
        var levels: ChannelLevels?
        guard decodeAAC(esds: esds, windows: reads, sink: { pcm, channels in
            if levels == nil { levels = ChannelLevels(channels: channels) }
            for v in pcm { levels!.add(Double(v)) }
        }) else { return nil }
        return levels?.db
    }
}

/// Mono samples from the planned sound windows at 16 kHz, which is what the classifier listens at. Windows follow on directly,
/// so a seam is a small click and nothing more.
struct MonoAudio {
    var samples: [Float] = []
    var rate = 0.0
    /// Mean square, for choosing the loudest track. Under 1e-6, -60 dBFS, there's nothing to listen to.
    var energy: Float { samples.isEmpty ? 0 : samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(samples.count) }
}

let soundRate = 16000.0

/// Takes one signal to 16 kHz. Higher rates are averaged down a whole frame at a time. Lower ones are drawn between
/// neighbouring samples, so that 8 kHz isn't heard at double speed.
private struct Resampler {
    let step: Double
    var phase = 0.0, sum = 0.0, frames = 0
    var previous: Double?
    var out: [Float] = []
    init(sourceRate: Double) { step = soundRate / sourceRate }

    mutating func add(_ value: Double) {
        if step <= 1 {
            sum += value
            frames += 1
            phase += step
            if phase >= 1 {
                phase -= 1
                out.append(Float(sum / Double(frames)))
                sum = 0
                frames = 0
            }
        } else {
            // Each input sample is reached `step` output samples after the last: fill the gap on a straight line.
            let from = previous ?? value
            phase += step
            while phase >= 1 {
                phase -= 1
                let t = 1 - phase / step
                out.append(Float(from + (value - from) * t))
            }
            previous = value
        }
    }
}

private func meanSquare(_ s: [Float]) -> Float { s.isEmpty ? 0 : s.reduce(Float(0)) { $0 + $1 * $1 } / Float(s.count) }

/// Makes one 16 kHz signal from interleaved channels. A channel more than 40 dB below the loudest is left out: it's a dead
/// input, which adds nothing and would halve a live one, such as a lav beside it. A quieter channel with something on it stays:
/// the classifier still heard a tone 24 dB down in a mix. The rest are mixed, unless the mix keeps less than a
/// quarter of their mean energy, which only channels in opposite polarity do: then the loudest is heard on its own. Two
/// unrelated channels mix to half their mean, a camera mic under a lav included, so they still mix. Up to 16 channels a track
/// are heard; a file claiming more is damaged.
struct MonoPicker {
    private var each: [Resampler]
    private let channels: Int
    private var at = 0

    init(channels: Int, sourceRate: Double) {
        self.channels = max(1, channels)
        each = Array(repeating: Resampler(sourceRate: sourceRate), count: min(self.channels, 16))
    }

    mutating func startWindow() { at = 0 }

    mutating func add(_ v: Double) {
        if at < each.count { each[at].add(v) }
        at += 1
        if at == channels { at = 0 }
    }

    func finish() -> MonoAudio? {
        // Resampling is linear, so mixing the 16 kHz channels is the same as resampling their mix.
        let outs = each.map(\.out)
        let energy = outs.map(meanSquare)
        guard let loudest = energy.indices.max(by: { energy[$0] < energy[$1] }) else { return nil }
        let kept = energy.indices.filter { energy[$0] * 10_000 >= energy[loudest] && outs[$0].count == outs[loudest].count }
        var chosen = outs[loudest]
        if kept.count > 1 {
            var mix = [Float](repeating: 0, count: chosen.count)
            for c in kept { for i in mix.indices { mix[i] += outs[c][i] } }
            let k = Float(kept.count)
            for i in mix.indices { mix[i] /= k }
            let mean = kept.map { energy[$0] }.reduce(0, +) / k
            if meanSquare(mix) >= 0.25 * mean { chosen = mix }
        }
        return chosen.isEmpty ? nil : MonoAudio(samples: chosen, rate: soundRate)
    }
}

/// One track's sound windows as a single 16 kHz signal, mixed or its loudest channel, as `MonoPicker` decides.
func readMono(_ plan: AudioPlan, file: MediaFile) -> MonoAudio? {
    guard plan.rate >= 8000, plan.rate <= 384_000 else { return nil }
    switch plan.kind {
    case .pcm(let bits, let float, let big, let channels):
        var picker = MonoPicker(channels: channels, sourceRate: plan.rate)
        for w in plan.windows {
            guard let b = try? file.read(at: w.offset, count: w.bytes) else { continue }
            picker.startWindow()
            forEachPCM(b.bytes, bits: bits, float: float, big: big) { picker.add($0) }
        }
        return picker.finish()
    case .aac(let esds, _):
        let reads = joinRuns(plan.windows, file: file)
        var picker: MonoPicker?
        guard decodeAAC(esds: esds, windows: reads, sink: { pcm, channels in
            if picker == nil { picker = MonoPicker(channels: channels, sourceRate: plan.rate) }
            for v in pcm { picker!.add(Double(v)) }
        }) else { return nil }
        return picker?.finish()
    }
}
