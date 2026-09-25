import Foundation

enum DeepLink: Equatable {
    /// `eddy://setup?userId=<uuid>` — an identity claim, not a navigation.
    case setup(userId: String)
    /// Anything else, normalised to a web path plus the query items worth keeping.
    case route(path: String, query: [URLQueryItem])
}

/// `eddy://` is the only link scheme (ADR-0013: universal links would need
/// Apple to fetch an association file from a host that resolves tailnet-only).
/// Paths mirror the web routes exactly, so a link is a scheme swap, not a rewrite.
enum DeepLinkRouter {
    static let scheme = "eddy"
    static let fallbackPath = "/feed"

    static let leafRoutes: Set<String> = ["feed", "saved", "search", "profile", "request", "admin", "decisions"]
    static let parameterisedRoutes: Set<String> = ["watch", "person"]

    /// Pure: URL in, intent out. Returns nil for anything that isn't `eddy://`.
    static func parse(_ url: URL) -> DeepLink? {
        guard url.scheme?.lowercased() == scheme else { return nil }

        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let query = components?.queryItems ?? []
        let carried = query.filter { !WebURLBuilder.identityKeys.contains($0.name.lowercased()) }

        // `eddy://feed` parses with "feed" as the host and an empty path, while
        // `eddy:///feed` puts it in the path. Rejoin before matching.
        var segments: [String] = []
        if let host = url.host(), !host.isEmpty { segments.append(host) }
        segments += (components?.path ?? "").split(separator: "/").map(String.init)

        guard let root = segments.first?.lowercased() else {
            return .route(path: fallbackPath, query: carried)
        }

        if root == "setup" {
            if let claimed = query
                .first(where: { WebURLBuilder.identityKeys.contains($0.name.lowercased()) })?
                .value
                .flatMap(UUIDValidator.normalise) {
                return .setup(userId: claimed)
            }
            return .route(path: fallbackPath, query: carried)
        }

        if leafRoutes.contains(root), segments.count == 1 {
            return .route(path: "/" + root, query: carried)
        }
        if parameterisedRoutes.contains(root), segments.count == 2, !segments[1].isEmpty {
            return .route(path: "/" + root + "/" + segments[1], query: carried)
        }

        return .route(path: fallbackPath, query: carried)
    }
}
