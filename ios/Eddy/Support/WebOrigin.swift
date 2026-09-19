import Foundation

/// Scheme + host + port, compared the way a browser compares origins.
/// This is the unit the kid-safety navigation policy is written against:
/// the web view may reach exactly one origin and nothing else.
struct WebOrigin: Equatable, Sendable {
    let scheme: String
    let host: String
    let port: Int

    init?(url: URL) {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host()?.lowercased(), !host.isEmpty,
              let port = url.port ?? Self.defaultPort(for: scheme)
        else { return nil }
        self.scheme = scheme
        self.host = host
        self.port = port
    }

    func matches(_ url: URL) -> Bool {
        // `https://eddyhq.app@evil.example/` parses with host `evil.example`,
        // but parsers disagree often enough that embedded credentials are
        // refused outright rather than reasoned about.
        guard url.user() == nil, url.password() == nil else { return false }
        guard let other = WebOrigin(url: url) else { return false }
        return self == other
    }

    private static func defaultPort(for scheme: String) -> Int? {
        switch scheme {
        case "https": 443
        case "http": 80
        default: nil
        }
    }
}
