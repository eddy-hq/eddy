import Foundation

/// `GET /notifications/{messageId}` — the call the Notification Service
/// Extension makes to turn an opaque push into the real thing. Holds no state,
/// takes its transport by injection, and answers nil for every failure: the
/// caller's only fallback is the placeholder copy Apple already delivered.
struct NotificationContentClient: Sendable {
    /// Four seconds, not the twenty `RequestClient` allows. iOS gives the
    /// extension around thirty, but a person is looking at the placeholder
    /// banner for the whole wait: the spike showed that with the tailnet down
    /// the fetch burns its entire timeout before the fallback copy appears. A
    /// reachable M4 answered in 66 ms, so four is generous and doesn't feel
    /// like a hang.
    static let defaultTimeout: TimeInterval = 4

    let baseURL: URL
    let transport: any HTTPTransport
    let timeout: TimeInterval

    init(
        baseURL: URL,
        transport: any HTTPTransport = URLSession.shared,
        timeout: TimeInterval = NotificationContentClient.defaultTimeout
    ) {
        self.baseURL = baseURL
        self.transport = transport
        self.timeout = timeout
    }

    func content(messageId: String, userId: String) async -> NotificationContent? {
        try? await result(messageId: messageId, userId: userId).get()
    }

    /// The same fetch, saying why it failed. The reason never reaches a person
    /// in a shipping build — the extension shows the placeholder whatever it
    /// is — but a development build surfaces it, because the extension's log
    /// can't be read off a device without root.
    func result(messageId: String, userId: String) async -> Result<NotificationContent, NotificationFetchFailure> {
        let request: URLRequest
        do {
            request = try makeRequest(messageId: messageId, userId: userId)
        } catch {
            Log.push.error("Couldn't build the notification URL")
            return .failure(.badURL)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch {
            Log.push.notice("Notification fetch failed: \(error.localizedDescription, privacy: .public)")
            let nsError = error as NSError
            return .failure(.transport(domain: nsError.domain, code: nsError.code))
        }

        guard let http = response as? HTTPURLResponse else { return .failure(.notHTTP) }
        guard http.statusCode == 200 else {
            // 404 is the ordinary shape of an expired message, or one that
            // belongs to another member of the household.
            Log.push.notice("Notification fetch answered \(http.statusCode, privacy: .public)")
            return .failure(.status(http.statusCode))
        }
        guard let content = try? JSONDecoder().decode(NotificationContent.self, from: data) else {
            Log.push.error("Notification response didn't parse")
            return .failure(.unparseable)
        }
        return .success(content)
    }

    /// Built from components rather than `URL(string:relativeTo:)` so a base
    /// URL with a path prefix keeps it instead of having it replaced.
    func makeRequest(messageId: String, userId: String) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw URLError(.badURL)
        }
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = basePath + "/notifications/" + messageId
        // Spelled out rather than borrowed from `WebURLBuilder`, which is the
        // app's own: `Shared/` compiles into the extensions too.
        components.queryItems = [URLQueryItem(name: "userId", value: userId)]
        components.fragment = nil
        guard let url = components.url else { throw URLError(.badURL) }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }
}

/// Why a notification's content couldn't be fetched. Carries no content, ids
/// or identity — only the shape of the failure.
enum NotificationFetchFailure: Error, Equatable {
    case badURL
    case transport(domain: String, code: Int)
    case notHTTP
    case status(Int)
    case unparseable

    var debugLabel: String {
        switch self {
        case .badURL: "bad URL"
        case .transport(let domain, let code): "\(domain) \(code)"
        case .notHTTP: "no HTTP response"
        case .status(let code): "HTTP \(code)"
        case .unparseable: "unparseable response"
        }
    }
}
