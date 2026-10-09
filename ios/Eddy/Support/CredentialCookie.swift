import Foundation
import WebKit

/// The web view's half of the device credential (ADR-0016). The PWA's own
/// fetches are origin-relative and carry cookies, so the shell gives its web
/// view the same `eddy_device` cookie a browser gets from redeeming an invite
/// — and the PWA never knows whether it is in the shell or in Safari.
enum CredentialCookie {
    static let name = "eddy_device"

    /// Matches what the server sets: host-only, whole site, HttpOnly, and
    /// Secure over HTTPS. The server caps a browser's cookie at 400 days and
    /// renews it on use; the shell re-installs it on every launch anyway.
    static func make(credential: String, for url: URL, now: Date = Date()) -> HTTPCookie? {
        guard let host = url.host(), !host.isEmpty else { return nil }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: credential,
            .domain: host,
            .path: "/",
            .expires: now.addingTimeInterval(400 * 24 * 60 * 60),
            .sameSitePolicy: HTTPCookieStringPolicy.sameSiteLax,
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        ]
        if url.scheme?.lowercased() == "https" { properties[.secure] = "TRUE" }
        return HTTPCookie(properties: properties)
    }

    @MainActor
    static func install(_ credential: String?, for url: URL, in store: WKHTTPCookieStore) async {
        for existing in await store.allCookies() where existing.name == name {
            await store.deleteCookie(existing)
        }
        guard let credential, let cookie = make(credential: credential, for: url) else { return }
        await store.setCookie(cookie)
    }
}
