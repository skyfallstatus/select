import AVFAudio
import CoreMedia
import Foundation
import SoundAnalysis

private let soundWindow = 2.0

private final class SoundResults: NSObject, SNResultsObserving {
    var best: [String: Double] = [:]
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let r = result as? SNClassificationResult else { return }
        for c in r.classifications where c.confidence >= 0.05 {
            best[c.identifier] = max(best[c.identifier] ?? 0, c.confidence)
        }
    }
}

/// Apple's built-in sound classifier over the sampled windows.
final class SoundWorker {
    private let request: SNClassifySoundRequest?

    init() {
        let r = try? SNClassifySoundRequest(classifierIdentifier: .version1)
        r?.overlapFactor = 0
        // The default window is 3 s, and audio shorter than a window gives no answer at all. Two seconds matches what's sampled.
        r?.windowDuration = CMTime(seconds: soundWindow, preferredTimescale: 16000)
        request = r
    }

    func classify(_ audio: MonoAudio, path: String = "") -> [String: Double]? {
        testHang("sound", path: path)
        guard !audio.samples.isEmpty else { return nil }
        // A very short clip plays round again until it fills a window.
        var samples = audio.samples
        while Double(samples.count) < soundWindow * audio.rate { samples += audio.samples }
        guard let request, let format = AVAudioFormat(standardFormatWithSampleRate: audio.rate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = buffer.frameCapacity
        samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: $0.count) }
        let results = SoundResults()
        let analyzer = SNAudioStreamAnalyzer(format: format)
        guard (try? analyzer.add(request, withObserver: results)) != nil else { return nil }
        analyzer.analyze(buffer, atAudioFramePosition: 0)
        analyzer.completeAnalysis()
        return results.best
    }
}
