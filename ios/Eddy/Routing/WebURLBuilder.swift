import Foundation

/// The single place the shell turns a path into a URL to load.
///
/// The PWA identifies the user purely by `?userId=` and re-appends it by hand
/// on every internal navigation. The shell can't fix that from out here, but it
/// can guarantee the parameter is present on every URL *it* supplies — initial
/// load, deep link, retry — so the web app never starts from a bare path.
enum WebURLBuilder {
    static let userIdKey = "userId"

    /// Query keys the PWA reads as identity. Anything arriving from outside
    /// carrying one of these is stripped: the shell owns who you are.
    static let identityKeys: Set<String> = ["userid", "user"]

    static func url(base: URL, path: String, query: [URLQueryItem] = [], userId: String) -> URL? {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }

        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        let suffix = path.hasPrefix("/") ? path : "/" + path
        components.path = basePath + suffix

        var items = query.filter { !identityKeys.contains($0.name.lowercased()) }
        items.append(URLQueryItem(name: userIdKey, value: userId))
        components.queryItems = items
        components.fragment = nil

        return components.url
    }
}
