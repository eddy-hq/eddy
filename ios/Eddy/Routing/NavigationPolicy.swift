import Foundation

enum NavigationDecision: Equatable {
    /// Load it in the web view.
    case allow
    /// Hand it to the system browser — a tapped off-site link, outside the app.
    case openExternally
    /// Cancel it and say nothing.
    case block
}

/// Kid safety, non-negotiable: the web view must never become a general browser.
///
/// A main-frame navigation is allowed only to the configured origin. Anything
/// else leaves the app entirely if a person tapped it, and is dropped if it
/// tried to happen on its own.
enum NavigationPolicy {
    /// Schemes worth handing to the system when a person deliberately tapped
    /// them. Everything else — `javascript:`, `data:`, `file:`, `eddy:` — is
    /// dropped rather than opened.
    static let externallyOpenableSchemes: Set<String> = ["http", "https", "mailto", "tel", "sms", "facetime"]

    static func decide(
        url: URL?,
        isMainFrame: Bool,
        isUserInitiated: Bool,
        origin: WebOrigin
    ) -> NavigationDecision {
        // Sub-frames are the page's own business: blocking them would break
        // embeds without adding a boundary, since the page is already trusted.
        guard isMainFrame else { return .allow }
        guard let url else { return .block }
        if origin.matches(url) { return .allow }

        guard isUserInitiated,
              let scheme = url.scheme?.lowercased(),
              externallyOpenableSchemes.contains(scheme)
        else { return .block }

        return .openExternally
    }
}
