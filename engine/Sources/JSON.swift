import Foundation

func jsonString(_ s: String) -> String {
    var out = "\""
    out.reserveCapacity(s.utf8.count + 2)
    for u in s.unicodeScalars {
        switch u {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if u.value < 0x20 {
                out += String(format: "\\u%04x", u.value)
            } else {
                out.unicodeScalars.append(u)
            }
        }
    }
    return out + "\""
}

/// Builds the comma-separated field list of a line. Nil becomes JSON null.
struct Fields {
    var parts: [String] = []
    mutating func add(_ k: String, _ v: String?) { parts.append("\"\(k)\":" + (v.map(jsonString) ?? "null")) }
    mutating func add(_ k: String, _ v: Int?) { parts.append("\"\(k)\":" + (v.map(String.init) ?? "null")) }
    mutating func add(_ k: String, _ v: Int64?) { parts.append("\"\(k)\":" + (v.map { String($0) } ?? "null")) }
    mutating func add(_ k: String, _ v: Bool?) { parts.append("\"\(k)\":" + (v.map { $0 ? "true" : "false" } ?? "null")) }
    mutating func add(_ k: String, _ v: Double?, _ places: Int = 3) {
        guard let v, v.isFinite else {
            parts.append("\"\(k)\":null")
            return
        }
        parts.append("\"\(k)\":" + String(format: "%.\(places)f", v))
    }
    /// A value that is already JSON, such as an array.
    mutating func addRaw(_ k: String, _ json: String?) { parts.append("\"\(k)\":" + (json ?? "null")) }
    var joined: String { parts.joined(separator: ",") }
}
