import Foundation

// Nothing a framework does may stop a scan from ending. Every clip gets a deadline: past it, the clip is settled with blanks and
// a plain reason, whatever can be cancelled is, and the scan moves on. A thread that's truly stuck is left behind, and the
// process ending takes it away.

/// Seconds a clip may take, per tier. Generous: the slow route through ffmpeg stays well inside them on real clips.
let tier0Deadline = testDeadline ?? 20
let tier1Deadline = testDeadline ?? 30
let tier2Deadline = testDeadline ?? 45
private let testDeadline = ProcessInfo.processInfo.environment["ENGINE_TEST_DEADLINE"].flatMap(Double.init)

/// Set only by engine/tests/contract.sh: a clip whose path contains "hang" stops at the named stage, as a stuck framework would.
func testHang(_ stage: String, path: String) {
    guard ProcessInfo.processInfo.environment["ENGINE_TEST_HANG"] == stage, path.contains("hang") else { return }
    while true { sleep(3600) }
}

/// Runs `body` for every item on `threads` threads. `body` calls `claim` just before it reports anything, and only reports if
/// that returns true. An item past its deadline is claimed by the runner instead and handed to `late`. Its thread is cancelled
/// as far as `cancel` can, left behind, and replaced, up to a limit. Once that limit is reached, every item not yet started is
/// handed to `skipped` instead: something is stuck for good, and the scan must still end. Returns once every item is settled.
func runGuarded(_ threads: Int, items: Int, stack: Int, deadline: Double,
                body: @escaping (_ item: Int, _ slot: Int, _ claim: () -> Bool) -> Void,
                late: @escaping (_ item: Int) -> Void,
                skipped: @escaping (_ item: Int) -> Void,
                cancel: @escaping (_ slot: Int) -> Void = { _ in }) {
    guard items > 0 else { return }
    let spares = 64
    let lock = NSCondition()
    var next = 0
    var settledCount = 0
    // 0 waiting, 1 claimed by its thread, which is reporting, 2 settled. An item counts as done only when its thread returns
    // or its deadline passes, so nothing that follows can read a result that's still being written.
    let state = UnsafeMutablePointer<UInt8>.allocate(capacity: items)
    state.initialize(repeating: 0, count: items)
    var working = [(item: Int, started: Double)?](repeating: nil, count: threads + spares)
    var abandoned = [Bool](repeating: false, count: threads + spares)
    var slotsUsed = 0

    func settle(_ i: Int) {             // with the lock held
        guard state[i] != 2 else { return }
        state[i] = 2
        settledCount += 1
        lock.broadcast()
    }

    func start(_ slot: Int) {
        let t = Thread {
            while true {
                lock.lock()
                if abandoned[slot] || next >= items {
                    lock.unlock()
                    return
                }
                let i = next
                next += 1
                working[slot] = (i, now())
                lock.unlock()
                body(i, slot) {
                    lock.lock()
                    defer { lock.unlock() }
                    guard !abandoned[slot], state[i] == 0 else { return false }
                    state[i] = 1
                    return true
                }
                lock.lock()
                if abandoned[slot] {
                    lock.unlock()
                    return
                }
                working[slot] = nil
                settle(i)
                lock.unlock()
            }
        }
        t.qualityOfService = .userInitiated
        t.stackSize = stack
        t.start()
    }

    lock.lock()
    for _ in 0..<min(threads, items) {
        start(slotsUsed)
        slotsUsed += 1
    }
    while settledCount < items {
        lock.wait(until: Date().addingTimeInterval(0.1))
        let t = now()
        var lateItems: [(item: Int, slot: Int)] = []
        var lost = 0
        for slot in 0..<slotsUsed {
            guard let w = working[slot], !abandoned[slot], t - w.started > deadline * 1000 else { continue }
            abandoned[slot] = true
            working[slot] = nil
            lost += 1
            // A thread that already began reporting gets no second line, only an end to the wait.
            if state[w.item] == 0 { lateItems.append((w.item, slot)) }
            settle(w.item)
        }
        if lost == 0 { continue }
        lock.unlock()
        for (item, slot) in lateItems {
            trace.route("late")
            late(item)
            cancel(slot)
        }
        lock.lock()
        var unstarted = 0..<0
        for _ in 0..<lost where next < items {
            guard slotsUsed < threads + spares else {
                // No replacement left. Nothing more is handed out: what's waiting is settled here, with its reason.
                unstarted = next..<items
                next = items
                break
            }
            start(slotsUsed)
            slotsUsed += 1
        }
        if unstarted.isEmpty { continue }
        for i in unstarted { state[i] = 2 }
        lock.unlock()
        for i in unstarted {
            trace.route("unstarted")
            skipped(i)
        }
        lock.lock()
        settledCount += unstarted.count
    }
    lock.unlock()
}

/// Ends the process as soon as nobody is reading stdout, rather than at the next line. Only a pipe or socket can close.
func watchForClosedOutput() {
    var st = stat()
    guard fstat(1, &st) == 0, (st.st_mode & S_IFMT) == S_IFIFO || (st.st_mode & S_IFMT) == S_IFSOCK else { return }
    let t = Thread {
        while true {
            var p = pollfd(fd: 1, events: Int16(POLLOUT), revents: 0)
            if poll(&p, 1, 0) > 0, p.revents & Int16(POLLHUP | POLLERR | POLLNVAL) != 0 {
                stopChildren()
                _exit(0)
            }
            usleep(200_000)
        }
    }
    t.qualityOfService = .utility
    t.start()
}
