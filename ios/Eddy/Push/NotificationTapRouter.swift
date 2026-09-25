import Foundation

/// Turns the `actionUrl` the service extension stashed on a notification into
/// the `eddy://` link the shell already knows how to route.
///
/// Going through the deep-link form on purpose: the shell has exactly one way
/// to navigate, and a tapped notification is not a reason to grow a second.
enum NotificationTapRouter {
    /// nil means "just open the app" — either the notification had nowhere to
    /// go, or the extension's fetch failed and never learned where.
    static func deepLink(in userInfo: [AnyHashable: Any]) -> URL? {
        guard let path = userInfo[PushMessage.actionURLKey] as? String else { return nil }
        return deepLink(forActionPath: path)
    }

    static func deepLink(forActionPath path: String) -> URL? {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        // Same-origin web paths only. An absolute URL is refused rather than
        // compared against the origin — Eddy's own host included — and
        // "//host/x" is an absolute URL wearing a path's clothes.
        guard trimmed.hasPrefix("/"), !trimmed.hasPrefix("//") else { return nil }
        guard let parsed = URLComponents(string: trimmed),
              parsed.scheme == nil, parsed.host == nil, parsed.user == nil
        else { return nil }

        var link = URLComponents()
        link.scheme = DeepLinkRouter.scheme
        link.host = ""
        link.path = parsed.path
        link.queryItems = parsed.queryItems
        return link.url
    }
}
