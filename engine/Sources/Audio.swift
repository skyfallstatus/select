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

private func addPCM(_ b: Bytes, bits: Int, float: Bool, big: Bool, into level: inout Level) {
    forEachPCM(b, bits: bits, float: float, big: big) { level.add($0) }
}

@inline(__always)
private func forEachPCM(_ b: Bytes, bits: Int, float: Bool, big: Bool, _ add: (Double) -> Void) {
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

/// Decodes short AAC runs with one converter. The first packets of a window only prime the
/// overlap, so their output is dropped.
private func addAAC(esds: Data, windows: [(ReadBuffer, [(at: Int, size: Int)])], into level: inout Level) -> Bool {
    decodeAAC(esds: esds, windows: windows) { pcm, _ in
        for v in pcm { level.add(Double(v)) }
    }
}

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

func measureAudio(_ plan: AudioPlan, file: MediaFile) -> Double? {
    var level = Level()
    switch plan.kind {
    case .pcm(let bits, let float, let big, _):
        for w in plan.windows {
            guard let b = try? file.read(at: w.offset, count: w.bytes) else { continue }
            addPCM(b.bytes, bits: bits, float: float, big: big, into: &level)
        }
    case .aac(let esds, _):
        var reads: [(ReadBuffer, [(at: Int, size: Int)])] = []
        for w in plan.windows {
            guard let b = try? file.read(at: w.offset, count: w.bytes), b.count == w.bytes else { continue }
            reads.append((b, w.packets))
        }
        guard addAAC(esds: esds, windows: reads, into: &level) else { return nil }
    }
    return level.db
}

/// Mono samples from the planned sound windows at 16 kHz, which is what the classifier listens at. Windows follow on directly,
/// so a seam is a small click and nothing more.
struct MonoAudio {
    var samples: [Float] = []
    var rate = 0.0
}

private let soundRate = 16000.0

func readMono(_ plan: AudioPlan, sourceRate: Double, file: MediaFile) -> MonoAudio? {
    guard sourceRate >= 8000, sourceRate <= 384_000 else { return nil }
    var out = MonoAudio()
    out.rate = soundRate
    // Everything goes to 16 kHz, which is the only rate the classifier answered at in testing. Higher rates are averaged down
    // a whole frame at a time. Lower ones are drawn between neighbouring samples, so that 8 kHz isn't heard at double speed.
    let step = soundRate / sourceRate
    var acc = 0.0, inFrame = 0, frames = 0, phase = 0.0, sum = 0.0, previous: Double?
    func take(_ v: Double, _ channels: Int) {
        acc += v
        inFrame += 1
        guard inFrame == channels else { return }
        let value = acc / Double(channels)
        acc = 0
        inFrame = 0
        if step <= 1 {
            sum += value
            frames += 1
            phase += step
            if phase >= 1 {
                phase -= 1
                out.samples.append(Float(sum / Double(frames)))
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
                out.samples.append(Float(from + (value - from) * t))
            }
            previous = value
        }
    }
    switch plan.kind {
    case .pcm(let bits, let float, let big, let channels):
        for w in plan.windows {
            guard let b = try? file.read(at: w.offset, count: w.bytes) else { continue }
            forEachPCM(b.bytes, bits: bits, float: float, big: big) { take($0, channels) }
        }
    case .aac(let esds, _):
        // Pieces of one run are joined before decoding, because the decoder needs its first packets to settle and a piece
        // can be a single packet.
        var runs: [Int: (bytes: [UInt8], packets: [(at: Int, size: Int)])] = [:]
        for w in plan.windows {
            guard let b = try? file.read(at: w.offset, count: w.bytes), b.count == w.bytes else { continue }
            var whole = runs[w.run] ?? ([], [])
            let base = whole.bytes.count
            whole.bytes.append(contentsOf: UnsafeBufferPointer(start: b.view, count: b.count))
            whole.packets += w.packets.map { ($0.at + base, $0.size) }
            runs[w.run] = whole
        }
        let reads: [(ReadBuffer, [(at: Int, size: Int)])] = runs.sorted { $0.key < $1.key }.compactMap { _, r in
            guard !r.bytes.isEmpty, let raw = malloc(r.bytes.count) else { return nil }
            r.bytes.withUnsafeBytes { raw.copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
            return (ReadBuffer(raw: raw, skip: 0, count: r.bytes.count), r.packets)
        }
        guard decodeAAC(esds: esds, windows: reads, sink: { pcm, channels in
            for v in pcm { take(Double(v), channels) }
        }) else { return nil }
    }
    return out.samples.isEmpty ? nil : out
}
