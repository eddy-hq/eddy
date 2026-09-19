import Foundation

/// A document-start user script exposing the shell to the page.
///
/// Read-only and additive: the PWA does not use it yet, and the shell does not
/// patch `history.pushState` or otherwise reach into the app's routing. If a
/// page drops `?userId=`, that's a PWA bug to fix in the PWA.
enum ShellBridge {
    static func userScriptSource(userId: String, version: String) -> String {
        let payload = ["userId": userId, "version": version]
        let json = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        // JSONSerialization leaves U+2028/U+2029 raw; JavaScript treats them as
        // line terminators, which would break the statement.
        let safe = json
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return "window.__EDDY_SHELL__ = Object.freeze(\(safe));"
    }
}
