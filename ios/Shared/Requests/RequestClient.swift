import Foundation

/// What `POST /requests` answered, reduced to the only distinctions a person
/// needs to see. The server owns the wording of everything it can speak to —
/// the client never re-implements YouTube URL validation or invents copy for
/// a case the server already explained.
enum RequestOutcome: Equatable, Sendable {
    /// 202. The dedup path answers with this shape too (same status, same
    /// body, no new download), so there is nothing for the client to tell
    /// apart — `status` just comes back `ready` instead of `downloading`.
    case accepted(message: String, status: String)
    /// 400 or 404 — the server said no and said why, in words for a person.
    case refused(message: String)
    /// Couldn't ask at all: no route to the host, or no answer in time.
    case unreachable
    /// 5xx, or an answer we couldn't parse. Nothing the person did wrong.
    case serverError
}

protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPTransport {
    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try await data(for: request)
    }
}

/// Posts a shared link to Eddy. Pure in the sense that matters: it holds no
/// state, takes its transport by injection, and turns every possible outcome
/// into a `RequestOutcome` rather than throwing at its callers.
struct RequestClient: Sendable {
    /// The server resolves short links itself (a `youtu.be` or a share link
    /// costs it a redirect hop), so the ceiling is generous.
    static let defaultTimeout: TimeInterval = 20

    let baseURL: URL
    let transport: any HTTPTransport
    let timeout: TimeInterval

    init(
        baseURL: URL,
        transport: any HTTPTransport = URLSession.shared,
        timeout: TimeInterval = RequestClient.defaultTimeout
    ) {
        self.baseURL = baseURL
        self.transport = transport
        self.timeout = timeout
    }

    /// `sharedText` is sent exactly as it arrived — the server extracts the
    /// first http(s) URL from it and decides whether it's something Eddy can
    /// fetch. Trimming or rewriting it here would only make the two
    /// disagree.
    func submit(sharedText: String, userId: String) async -> RequestOutcome {
        let request: URLRequest
        do {
            request = try makeRequest(sharedText: sharedText, userId: userId)
        } catch {
            Log.requests.error("Couldn't build the request URL")
            return .serverError
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch {
            // URLError covers no-route, DNS, ATS and timeout alike; anything
            // else at this layer is equally "we never got an answer".
            Log.requests.notice("Share POST failed: \(error.localizedDescription, privacy: .public)")
            return .unreachable
        }

        guard let http = response as? HTTPURLResponse else { return .serverError }
        return outcome(status: http.statusCode, body: data)
    }

    // MARK: - Internals

    /// Exposed for the body test: the wire shape is part of the contract.
    struct Body: Encodable, Equatable, Sendable {
        let url: String
        let userId: String
    }

    private struct Accepted: Decodable {
        let requestId: String
        let status: String
        let message: String
    }

    private struct Failure: Decodable {
        let error: String
        let message: String
    }

    func makeRequest(sharedText: String, userId: String) throws -> URLRequest {
        // Built from components rather than `URL(string:relativeTo:)` so a base
        // URL with a path prefix keeps it instead of having it replaced.
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw URLError(.badURL)
        }
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = basePath + "/requests"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw URLError(.badURL) }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpBody = try JSONEncoder().encode(Body(url: sharedText, userId: userId))
        return request
    }

    private func outcome(status: Int, body: Data) -> RequestOutcome {
        switch status {
        case 200...299:
            guard let accepted = try? JSONDecoder().decode(Accepted.self, from: body) else {
                Log.requests.error("Accepted response didn't parse")
                return .serverError
            }
            return .accepted(message: accepted.message, status: accepted.status)
        case 400, 404:
            guard let failure = try? JSONDecoder().decode(Failure.self, from: body),
                  !failure.message.isEmpty
            else { return .serverError }
            return .refused(message: failure.message)
        default:
            Log.requests.notice("Share POST answered \(status, privacy: .public)")
            return .serverError
        }
    }
}
