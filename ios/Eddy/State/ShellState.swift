import Foundation

enum UnreachableReason: Equatable, Sendable {
    case network
    case timeout
}

enum ShellState: Equatable, Sendable {
    case setup
    case loading
    case loaded
    case unreachable(UnreachableReason)
}

enum ShellEvent: Equatable, Sendable {
    case identitySaved
    case identityCleared
    case loadStarted
    case loadFinished
    case loadFailed(UnreachableReason)
    case retry
    case foregrounded
}

extension ShellState {
    /// Pure transition table. Two rules earn their keep:
    ///
    /// - `loaded + loadStarted -> loaded`, so an in-page navigation doesn't
    ///   flash native chrome over a working web view.
    /// - `unreachable + foregrounded -> loading`, which is the automatic retry
    ///   when someone turns Tailscale back on and comes back to the app.
    func next(on event: ShellEvent) -> ShellState {
        if event == .identityCleared { return .setup }

        switch self {
        case .setup:
            return event == .identitySaved ? .loading : .setup

        case .loading:
            switch event {
            case .loadFinished: return .loaded
            case .loadFailed(let reason): return .unreachable(reason)
            default: return .loading
            }

        case .loaded:
            switch event {
            case .identitySaved, .retry: return .loading
            case .loadFailed(let reason): return .unreachable(reason)
            default: return .loaded
            }

        case .unreachable:
            switch event {
            case .retry, .foregrounded, .loadStarted, .identitySaved: return .loading
            case .loadFinished: return .loaded
            default: return self
            }
        }
    }
}
