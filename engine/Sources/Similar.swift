import Accelerate
import Foundation

/// One clip's feature prints, one per moment, joined end to end, and the clip's average colour.
struct ClipPrint {
    var values: [Float]
    var count: Int          // moments
    var revision: Int
    var a: Float = 0        // Oklab, the mean of what the clip shows
    var b: Float = 0
}

/// Where grouping finds a clip's print: in the cache file, or in memory when it couldn't be stored.
enum PrintSource {
    case stored(PrintRef)
    case held(ClipPrint)

    var revision: Int {
        switch self {
        case .stored(let r): return r.revision
        case .held(let p): return p.revision
        }
    }
    var color: (a: Float, b: Float) {
        switch self {
        case .stored(let r): return (r.a, r.b)
        case .held(let p): return (p.a, p.b)
        }
    }
}

/// Feature prints look at structure and texture and hardly at colour, so two macro shots of different paintings can sit
/// closer than two takes. Clips this far apart in average colour aren't the same setup.
private let sameSetupColor: Float = 0.03

/// How close two clips' prints must be to count as one setup. Each revision has its own scale: revision 2 was calibrated on
/// real repeated takes, and revision 1, which older macOS uses, was set to pick out the same pairs on the same clips.
/// A revision nobody has measured gets no groups rather than a guess.
func similarThreshold(revision: Int) -> Float? {
    switch revision {
    case 1: return 11
    case 2: return 0.37
    default: return nil
    }
}

/// How many clips after each one, in name order within its folder, are compared with it. Repeated takes in real footage sat
/// up to 156 clips apart. This keeps grouping linear in the size of a project.
let similarWindow = 256

/// Groups clips that show the same setup. Only clips in the same folder are compared: in testing, no similar pair crossed
/// folders. Each group is anchored on its first clip, so a group can't drift across a shoot one small step at a time.
/// Prints are read a window at a time, so memory stays flat however many clips there are.
/// `sortKey` orders clips within a folder, and `load` fetches a stored print.
func similarGroups(sources: [PrintSource?], folders: [String], sortKey: [String], revision: Int,
                   load: @escaping (PrintRef) -> ClipPrint?) -> [[Int]] {
    guard let threshold = similarThreshold(revision: revision) else { return [] }
    var byFolder: [String: [Int]] = [:]
    for i in sources.indices where sources[i]?.revision == revision { byFolder[folders[i], default: []].append(i) }
    let lists = byFolder.values.map { $0.sorted { sortKey[$0] < sortKey[$1] } }.filter { $0.count >= 2 }
    let lock = NSLock()
    var groups: [[Int]] = []
    DispatchQueue.concurrentPerform(iterations: lists.count) { n in
        let list = lists[n]
        var cache: [Int: ClipPrint] = [:]
        func print(_ i: Int) -> ClipPrint? {
            if let p = cache[i] { return p }
            var p: ClipPrint?
            switch sources[i] {
            case .stored(let r)?: p = load(r)
            case .held(let h)?: p = h
            case nil: p = nil
            }
            if let p { cache[i] = p }
            return p
        }
        var taken = [Bool](repeating: false, count: list.count)
        var found: [[Int]] = []
        for x in list.indices {
            // Prints behind the window are no longer needed.
            if x > 0 { cache[list[x - 1]] = nil }
            if taken[x] { continue }
            guard let pa = print(list[x]), pa.count > 0 else { continue }
            let dim = pa.values.count / pa.count
            let colorA = sources[list[x]]!.color
            var group = [list[x]]
            for y in (x + 1)..<min(list.count, x + 1 + similarWindow) where !taken[y] {
                let colorB = sources[list[y]]!.color
                let (da, db) = (colorA.a - colorB.a, colorA.b - colorB.b)
                guard da * da + db * db <= sameSetupColor * sameSetupColor else { continue }
                guard let pb = print(list[y]), pb.count > 0, pb.values.count / pb.count == dim else { continue }
                if closest(pa, pb, dim) < threshold {
                    taken[y] = true
                    group.append(list[y])
                }
            }
            if group.count >= 2 {
                taken[x] = true
                found.append(group)
            }
        }
        lock.lock()
        groups += found
        lock.unlock()
    }
    return groups.sorted { $0[0] < $1[0] }
}

/// Smallest distance between any moment of one clip and any moment of the other.
func closest(_ a: ClipPrint, _ b: ClipPrint, _ dim: Int) -> Float {
    var best = Float.infinity
    a.values.withUnsafeBufferPointer { pa in
        b.values.withUnsafeBufferPointer { pb in
            for i in 0..<a.count {
                for j in 0..<b.count {
                    var d: Float = 0
                    vDSP_distancesq(pa.baseAddress! + i * dim, 1, pb.baseAddress! + j * dim, 1, &d, vDSP_Length(dim))
                    best = min(best, d)
                }
            }
        }
    }
    return best.squareRoot()
}
