import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// One planar view of a decoded frame: 16-bit luma with interleaved 4:2:0 chroma, 10-bit codes in
/// the top bits, video range. VideoToolbox converts every source to this, so the maths has one path.
struct FrameView {
    let y: UnsafePointer<UInt16>
    let yStride: Int
    let width: Int
    let height: Int
    let uv: UnsafePointer<UInt16>
    let uvStride: Int
}

/// Why VideoToolbox gave no frame. `noDecoder` means this format, not this clip.
struct DecodeFailure {
    let noDecoder: Bool
    let status: OSStatus
}

enum Decoded<T> {
    case frame(T)
    case refused(DecodeFailure)
}

// Set only by engine/tests/contract.sh, to reach the paths a Mac without the decoder would take.
private let forcedFailure = ProcessInfo.processInfo.environment["ENGINE_TEST_DECODER"]

private struct SessionKey: Hashable {
    let format: UInt32
    let width: Int
    let height: Int
    let atoms: [String: Data]
}

private final class PooledSession {
    let key: SessionKey
    let session: VTDecompressionSession
    let description: CMVideoFormatDescription
    var hardware = false
    init(key: SessionKey, session: VTDecompressionSession, description: CMVideoFormatDescription) {
        self.key = key
        self.session = session
        self.description = description
    }
    func close() { VTDecompressionSessionInvalidate(session) }
}

/// What this run has learned about one format. Workers read it under the pool's lock.
private final class FormatState {
    let gate = NSLock()             // until a frame has worked, one worker at a time finds out
    var proven = false              // a frame of this format has decoded
    var failures = 0                // in a row, with none proven
    var closed: DecodeFailure?      // stop trying
    var skipped = 0
}

/// Frames that must fail in a row, with none decoded, before a format is given up on for this run.
/// More than one, so that a couple of damaged clips at the top of a list can't blank the rest.
private let failuresBeforeGivingUp = 3
/// A format given up on is still tried once in this many clips, so a wrong call can't last the run.
private let retryEvery = 16

/// Sessions cost 12 to 20 ms to open and clips from one camera share a format, so idle sessions are
/// kept and handed to whichever worker needs them next.
///
/// A Mac without a decoder for a format must lose little time finding that out, so the first clips of
/// a format go one at a time and a format that doesn't work stops being tried. The cost on a Mac that
/// has the decoder is one short wait, once per format.
final class DecoderPool {
    private var idle: [PooledSession] = []
    private var formats: [SessionKey: FormatState] = [:]
    private let lock = NSLock()
    private let capacity: Int

    init(capacity: Int) { self.capacity = capacity }

    private func take(_ key: SessionKey) -> PooledSession? {
        lock.lock()
        defer { lock.unlock() }
        guard let i = idle.lastIndex(where: { $0.key == key }) else { return nil }
        return idle.remove(at: i)
    }

    private func give(_ s: PooledSession) {
        lock.lock()
        idle.append(s)
        let evicted = idle.count > capacity ? idle.removeFirst() : nil
        lock.unlock()
        evicted?.close()
    }

    private func open(_ key: SessionKey, status: inout OSStatus) -> PooledSession? {
        if forcedFailure == "open" {
            status = kVTCouldNotFindVideoDecoderErr
            return nil
        }
        var ext: [String: Any] = [:]
        if !key.atoms.isEmpty {
            ext[kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms as String] = key.atoms
        }
        var desc: CMVideoFormatDescription?
        status = CMVideoFormatDescriptionCreate(allocator: nil, codecType: key.format, width: Int32(key.width),
                                                height: Int32(key.height), extensions: ext as CFDictionary,
                                                formatDescriptionOut: &desc)
        guard status == 0, let desc else { return nil }
        let attrs: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange]
        var session: VTDecompressionSession?
        status = VTDecompressionSessionCreate(allocator: nil, formatDescription: desc, decoderSpecification: nil,
                                              imageBufferAttributes: attrs as CFDictionary, outputCallback: nil,
                                              decompressionSessionOut: &session)
        guard status == 0, let session else { return nil }
        let pooled = PooledSession(key: key, session: session, description: desc)
        var hw: CFBoolean?
        withUnsafeMutablePointer(to: &hw) {
            _ = VTSessionCopyProperty(session, key: kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
                                      allocator: nil, valueOut: UnsafeMutableRawPointer($0))
        }
        pooled.hardware = hw.map { CFBooleanGetValue($0) } ?? false
        return pooled
    }

    /// A session that can't open may only mean the hardware is out of sessions, so idle ones go first.
    private func openFreeingIdle(_ key: SessionKey, status: inout OSStatus) -> PooledSession? {
        if let s = open(key, status: &status) { return s }
        lock.lock()
        let freed = idle
        idle.removeAll()
        lock.unlock()
        guard !freed.isEmpty else { return nil }
        freed.forEach { $0.close() }
        return open(key, status: &status)
    }

    private func state(for key: SessionKey) -> FormatState {
        lock.lock()
        defer { lock.unlock() }
        if let s = formats[key] { return s }
        let s = FormatState()
        formats[key] = s
        return s
    }

    /// Records what an attempt on a format not yet proven taught us.
    private func learn<T>(_ result: Decoded<T>, _ s: FormatState) -> Decoded<T> {
        lock.lock()
        defer { lock.unlock() }
        switch result {
        case .frame:
            s.proven = true
            s.closed = nil
            s.failures = 0
        case .refused(let why):
            trace.route("vt-refused")
            s.failures += 1
            // A session that won't open is about the format. A frame that won't decode may be about the clip.
            if why.noDecoder || s.failures >= failuresBeforeGivingUp {
                s.closed = DecodeFailure(noDecoder: true, status: why.status)
            }
        }
        return result
    }

    /// Decodes one sample and passes the locked frame to `body`. When VideoToolbox refuses, this says why,
    /// and the caller takes the slow route or reports the clip.
    func decode<T>(_ plan: VideoPlan, sample: ReadBuffer, body: (FrameView, Bool) -> T) -> Decoded<T> {
        let key = SessionKey(format: plan.format, width: plan.codedWidth, height: plan.codedHeight, atoms: plan.atoms)
        let s = state(for: key)
        lock.lock()
        let proven = s.proven
        lock.unlock()
        if proven { return attempt(key, sample, body) }

        s.gate.lock()
        defer { s.gate.unlock() }
        lock.lock()
        if s.proven {
            lock.unlock()
            return attempt(key, sample, body)
        }
        if let closed = s.closed {
            s.skipped += 1
            if s.skipped % retryEvery != 0 {
                lock.unlock()
                trace.route("vt-skipped")
                return .refused(closed)
            }
        }
        lock.unlock()
        return learn(attempt(key, sample, body), s)
    }

    private func attempt<T>(_ key: SessionKey, _ sample: ReadBuffer, _ body: (FrameView, Bool) -> T) -> Decoded<T> {
        var openStatus: OSStatus = 0
        guard let pooled = take(key) ?? openFreeingIdle(key, status: &openStatus) else {
            return .refused(DecodeFailure(noDecoder: true, status: openStatus))
        }
        func keepAndRefuse(_ status: OSStatus) -> Decoded<T> {
            give(pooled)
            return .refused(DecodeFailure(noDecoder: false, status: status))
        }

        var block: CMBlockBuffer?
        let raw = UnsafeMutableRawPointer(mutating: sample.view)
        let blockStatus = CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: raw, blockLength: sample.count,
                                                             blockAllocator: kCFAllocatorNull, customBlockSource: nil, offsetToData: 0,
                                                             dataLength: sample.count, flags: 0, blockBufferOut: &block)
        guard blockStatus == 0 else { return keepAndRefuse(blockStatus) }
        var sb: CMSampleBuffer?
        var size = sample.count
        let sampleStatus = CMSampleBufferCreateReady(allocator: nil, dataBuffer: block, formatDescription: pooled.description,
                                                     sampleCount: 1, sampleTimingEntryCount: 0, sampleTimingArray: nil,
                                                     sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sb)
        guard sampleStatus == 0, let sb else { return keepAndRefuse(sampleStatus) }
        var image: CVPixelBuffer?
        var status: OSStatus = 0
        var call: OSStatus = kVTVideoDecoderBadDataErr
        if forcedFailure != "frame" {
            call = VTDecompressionSessionDecodeFrame(pooled.session, sampleBuffer: sb, flags: [], infoFlagsOut: nil) { s, _, img, _, _ in
                status = s
                image = img
            }
        }
        if call == 0, image == nil, status == 0 {
            VTDecompressionSessionFinishDelayedFrames(pooled.session)
            VTDecompressionSessionWaitForAsynchronousFrames(pooled.session)
        }
        guard call == 0, status == 0, let image else {
            pooled.close()
            return .refused(DecodeFailure(noDecoder: false, status: call != 0 ? call : status))
        }
        defer { give(pooled) }
        // The maths reads 16-bit words, so a decoder that hands back anything else is a refusal, not a frame.
        guard CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
              CVPixelBufferGetPlaneCount(image) == 2,
              CVPixelBufferLockBaseAddress(image, .readOnly) == 0 else {
            return .refused(DecodeFailure(noDecoder: false, status: kVTPixelTransferNotSupportedErr))
        }
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        guard let yBase = CVPixelBufferGetBaseAddressOfPlane(image, 0),
              let uvBase = CVPixelBufferGetBaseAddressOfPlane(image, 1) else {
            return .refused(DecodeFailure(noDecoder: false, status: kVTPixelTransferNotSupportedErr))
        }
        let frame = FrameView(y: UnsafePointer(yBase.assumingMemoryBound(to: UInt16.self)),
                              yStride: CVPixelBufferGetBytesPerRowOfPlane(image, 0) / 2,
                              width: CVPixelBufferGetWidthOfPlane(image, 0),
                              height: CVPixelBufferGetHeightOfPlane(image, 0),
                              uv: UnsafePointer(uvBase.assumingMemoryBound(to: UInt16.self)),
                              uvStride: CVPixelBufferGetBytesPerRowOfPlane(image, 1) / 2)
        return .frame(body(frame, pooled.hardware))
    }

    func closeAll() {
        lock.lock()
        defer { lock.unlock() }
        idle.forEach { $0.close() }
        idle.removeAll()
    }
}
