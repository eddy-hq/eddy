import Foundation
import os

enum Log {
    /// Inside an extension this is the extension's own bundle id, which is
    /// what we want: the share extension's lines stay distinguishable from
    /// the app's in Console.
    private static let subsystem = Bundle.main.bundleIdentifier ?? "app.eddyhq.Eddy"

    /// App lifecycle, load state, deep links.
    static let shell = Logger(subsystem: subsystem, category: "shell")
    /// Navigation allow/deny decisions.
    static let navigation = Logger(subsystem: subsystem, category: "navigation")
    /// Keychain identity. Every userId logged here is `.private`.
    static let identity = Logger(subsystem: subsystem, category: "identity")
    /// The share extension and the App Intent. Shared URLs are `.private`:
    /// what someone asked for is consumption detail (§14).
    static let requests = Logger(subsystem: subsystem, category: "requests")
}
