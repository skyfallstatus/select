import AppKit
import Foundation

// `reveal`: files shown in the Finder, every one of them selected, for the panel's Reveal in Finder. `open -R` with
// several files selects only the last. NSWorkspace hands the files to the Finder itself, so it needs no permission to
// control the Finder. Files in several folders may open several windows.
//
// Files that aren't on disk are left out, and when none are, the Finder isn't asked. The whole run has a deadline.

func runReveal(_ a: [String]) {
    let start = now()
    guard !a.isEmpty, !a.contains(where: { $0.isEmpty || $0.hasPrefix("-") }) else { usage() }
    let urls = a.filter { FileManager.default.fileExists(atPath: $0) }.map { URL(fileURLWithPath: $0) }
    let output = Output()
    func ms() -> String { String(format: "%.1f", now() - start) }
    func answer() {
        output.emit("{\"type\":\"reveal\",\"shown\":\(urls.count),\"missing\":\(a.count - urls.count),\"ms\":\(ms())}")
    }
    if urls.isEmpty { return answer() }

    // The Finder may be busy. Past the deadline the answer is an error, whatever the call is still waiting on.
    let gate = NSLock()
    var settled = false
    // It ends the process holding the lock, so an answer can't follow its error.
    let watchdog = Thread {
        Thread.sleep(forTimeInterval: max(0, start + revealDeadline * 1000 - now()) / 1000)
        gate.lock()
        if !settled {
            settled = true
            output.emit("{\"type\":\"error\",\"message\":\"The Finder took too long.\",\"ms\":\(ms())}")
            _exit(0)
        }
        gate.unlock()
    }
    watchdog.start()

    testHang("reveal", path: urls.map(\.path).joined(separator: "\n"))
    if ProcessInfo.processInfo.environment["ENGINE_TEST_NO_FINDER"] != "1" {
        NSWorkspace.shared.activateFileViewerSelecting(urls)
    }
    gate.lock()
    settled = true
    answer()
    gate.unlock()
}
