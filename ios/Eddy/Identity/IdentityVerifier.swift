import Foundation

enum IdentityVerification: Equatable {
    case known
    case unknown
}

protocol IdentityVerifier: Sendable {
    /// Throws when the server couldn't be asked at all; returns `.unknown`
    /// only when the server actually answered "no such user".
    func verify(userId: String, base: URL) async throws -> IdentityVerification
}

/// `GET /avatars?userId=` — the cheapest endpoint that distinguishes a real
/// user from a typo: 200 with a small JSON avatar, 404 for an unknown id.
struct HTTPIdentityVerifier: IdentityVerifier {
    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    struct UnexpectedStatus: Error, Equatable {
        let code: Int
    }

    func verify(userId: String, base: URL) async throws -> IdentityVerification {
        guard let url = WebURLBuilder.url(base: base, path: "/avatars", userId: userId) else {
            throw UnexpectedStatus(code: 0)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw UnexpectedStatus(code: 0) }
        switch http.statusCode {
        case 200: return .known
        case 404: return .unknown
        default: throw UnexpectedStatus(code: http.statusCode)
        }
    }
}
