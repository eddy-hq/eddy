import Foundation

/// What Eddy fetches back once a push arrives. The payload that transits Apple
/// carries none of this (ADR-0004) — only the opaque id that names it.
struct NotificationContent: Decodable, Equatable, Sendable {
    let title: String
    let body: String
    /// A web path on Eddy's own origin — "/watch/<id>", "/admin". Absent for a
    /// notification with nowhere in particular to go.
    let actionUrl: String?
}

/// The two pieces of the push path that are pure: reading the opaque id out of
/// an APNs payload, and the key the service extension leaves the fetched
/// `actionUrl` under for the app's tap handler.
enum PushMessage {
    /// The whole payload is `{aps: {...}, m: "<uuid>"}`. One letter because it
    /// is the only custom key and every byte transits Apple.
    static let idKey = "m"

    /// Written into the delivered notification's `userInfo`, read back when the
    /// person taps it. Not a server field — the extension put it there.
    static let actionURLKey = "eddyActionUrl"

    /// nil for a push with no id, a non-string id, or one that isn't a UUID.
    /// The id goes straight into a URL path, so it is validated rather than
    /// trusted: a push is the one input to this app that arrives from outside
    /// the tailnet.
    static func id(in userInfo: [AnyHashable: Any]) -> String? {
        guard let raw = userInfo[idKey] as? String else { return nil }
        return UUIDValidator.normalise(raw)
    }
}
