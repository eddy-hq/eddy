import Foundation
import os

enum Log {
    private static let subsystem = Bundle.main.bundleIdentifier ?? "app.eddyhq.Eddy"

    /// App lifecycle, load state, deep links.
    static let shell = Logger(subsystem: subsystem, category: "shell")
    /// Navigation allow/deny decisions.
    static let navigation = Logger(subsystem: subsystem, category: "navigation")
    /// Keychain identity. Every userId logged here is `.private`.
    static let identity = Logger(subsystem: subsystem, category: "identity")
}
