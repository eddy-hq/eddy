import Foundation
import WebKit

/// The `WKNavigationAction` shape of `NavigationPolicy`, kept pure so the
/// kid-safety boundary is decided in a tested function rather than inside a
/// delegate callback.
enum WebNavigationPolicy {
    /// Everything about a navigation the decision depends on.
    struct Action: Equatable {
        let url: URL?
        let navigationType: WKNavigationType
        let targetIsMainFrame: Bool
        /// `targetFrame == nil` — `target="_blank"` or `window.open`.
        let opensNewWindow: Bool
    }

    enum Outcome: Equatable {
        /// Let the web view proceed.
        case allow
        /// Cancel, then load it in the web view we already have. The shell is
        /// one web view: a new-window request never spawns a second one.
        case loadInPlace(URL)
        /// Leave the app entirely — a person deliberately tapped an off-site link.
        case openExternally(URL)
        /// Cancel and say nothing.
        case block
    }

    /// A navigation a person caused. `.other` covers scripted navigations and
    /// redirects, which must never be able to walk the web view off-origin.
    static func isUserInitiated(_ type: WKNavigationType) -> Bool {
        switch type {
        case .linkActivated, .formSubmitted, .formResubmitted, .backForward: true
        default: false
        }
    }

    static func decide(_ action: Action, origin: WebOrigin) -> Outcome {
        let decision = NavigationPolicy.decide(
            url: action.url,
            // A new window has no target frame yet, but it is a top-level
            // navigation and gets judged as one.
            isMainFrame: action.targetIsMainFrame || action.opensNewWindow,
            isUserInitiated: isUserInitiated(action.navigationType),
            origin: origin
        )

        switch decision {
        case .allow:
            guard action.opensNewWindow, let url = action.url else { return .allow }
            return .loadInPlace(url)
        case .openExternally:
            guard let url = action.url else { return .block }
            return .openExternally(url)
        case .block:
            return .block
        }
    }
}
