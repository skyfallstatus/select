import CoreVideo
import Foundation

// Hidden subcommands used by the test scripts. Not part of the contract.

func decodeForDebug(_ path: String, _ pool: DecoderPool, body: (FrameView, Int?) -> Void) {
    guard let r = try? tier0(path: path), let f = try? MediaFile(path: path) else {
        log("tier0 failed for \(path)")
        return
    }
    if let v = r.plan.video, !r.plan.fallback, let s = try? f.read(at: v.offset, count: v.size) {
        if case .frame = pool.decode(v, sample: s, body: { frame, _, _ in body(frame, r.plan.bitDepth) }) { return }
    }
    _ = fallbackFrame(path: path, plan: r.plan) { body($0, r.plan.bitDepth) }
}

func runDebug(_ a: [String]) {
    let pool = DecoderPool(capacity: 2)
    defer { pool.closeAll() }
    switch a.first {
    case "dump" where a.count == 3:
        decodeForDebug(a[1], pool) { f, _ in
            var fh = [Int32(f.width), Int32(f.height)]
            let out = fopen(a[2], "wb")!
            fwrite(&fh, 4, 2, out)
            for y in 0..<f.height { fwrite(f.y + y * f.yStride, 2, f.width, out) }
            fclose(out)
        }
    case "grade" where a.count == 5:
        // debug grade <b> <g> <r> <a>: one BGRA pixel through the grade Vision gets. For the contract test.
        var pb: CVPixelBuffer?
        guard CVPixelBufferCreate(nil, 2, 2, kCVPixelFormatType_32BGRA, nil, &pb) == 0, let pb else { exit(1) }
        let v = a.dropFirst().compactMap { UInt8($0) }
        guard v.count == 4 else { exit(2) }
        CVPixelBufferLockBaseAddress(pb, [])
        let p = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
        for i in 0..<4 { p[i] = v[i] }
        CVPixelBufferUnlockBaseAddress(pb, [])
        gradeForVision(pb)
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        print((0..<4).map { String(p[$0]) }.joined(separator: " "))
        CVPixelBufferUnlockBaseAddress(pb, .readOnly)
    case "sharpraw" where a.count >= 2:
        // debug sharpraw <file.y16>...: the shipped score on luma planes made by a test script.
        for path in a.dropFirst() {
            guard let d = FileManager.default.contents(atPath: path), d.count > 8 else { continue }
            d.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
                let w = Int(p.load(as: Int32.self)), h = Int(p.load(fromByteOffset: 4, as: Int32.self))
                let y = (p.baseAddress! + 8).assumingMemoryBound(to: UInt16.self)
                print(String(format: "%.4f %@", sharpness(y: y, stride: w, width: w, height: h, sourceBits: 10) ?? -1, path))
            }
        }
    case "sharp" where a.count >= 2:
        // debug sharp <clip> [sigma...]: score of the decoded frame, then of the same frame blurred.
        let sigmas = a.dropFirst(2).compactMap(Double.init)
        decodeForDebug(a[1], pool) { f, bits in
            var parts = [String(format: "0=%.4f", sharpnessScore(f, sourceBits: bits) ?? -1)]
            for s in sigmas {
                let blurred = gaussianLuma(f, sigma: s)
                let score = blurred.withUnsafeBufferPointer {
                    sharpness(y: $0.baseAddress!, stride: f.width, width: f.width, height: f.height, sourceBits: bits)
                }
                parts.append(String(format: "%g=%.4f", s, score ?? -1))
            }
            print(parts.joined(separator: " "))
        }
    default:
        log("debug dump <clip> <out.raw> | debug sharp <clip> [sigma...]")
        exit(2)
    }
}
