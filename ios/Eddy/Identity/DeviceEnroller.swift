import Foundation

enum EnrolmentOutcome: Equatable, Sendable {
    case enrolled(DeviceIdentity)
    /// The server answered and refused the invite — expired, already used, or
    /// not an invite at all. The message is the server's, for a person.
    case rejected(message: String)
}

protocol DeviceEnroller: Sendable {
    /// Throws when the server couldn't be asked at all; returns `.rejected`
    /// only when it actually answered no.
    func enrol(invite: String, base: URL, deviceType: String) async throws -> EnrolmentOutcome
}

/// `POST /devices/enrol` (ADR-0016). Asks for the credential in the body
/// rather than as a cookie: the app keeps it in the Keychain for its
/// extensions and sets the web view's cookie itself.
struct HTTPDeviceEnroller: DeviceEnroller {
    let transport: any HTTPTransport

    init(transport: any HTTPTransport = URLSession.shared) {
        self.transport = transport
    }

    struct UnexpectedStatus: Error, Equatable {
        let code: Int
    }

    struct Body: Encodable, Equatable {
        let invite: String
        let deviceType: String
        let deliver: String
    }

    private struct Enrolled: Decodable {
        let userId: String
        let credential: String
    }

    private struct Refused: Decodable {
        let message: String
    }

    func makeRequest(invite: String, base: URL, deviceType: String) throws -> URLRequest {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw URLError(.badURL)
        }
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = basePath + "/devices/enrol"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw URLError(.badURL) }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpBody = try JSONEncoder().encode(Body(invite: invite, deviceType: deviceType, deliver: "body"))
        return request
    }

    func enrol(invite: String, base: URL, deviceType: String) async throws -> EnrolmentOutcome {
        let request = try makeRequest(invite: invite, base: base, deviceType: deviceType)
        let (data, response) = try await transport.send(request)
        guard let http = response as? HTTPURLResponse else { throw UnexpectedStatus(code: 0) }
        switch http.statusCode {
        case 200:
            guard let body = try? JSONDecoder().decode(Enrolled.self, from: data),
                  let identity = DeviceIdentity.make(userId: body.userId, credential: body.credential)
            else { throw UnexpectedStatus(code: 200) }
            return .enrolled(identity)
        case 400, 403:
            let message = (try? JSONDecoder().decode(Refused.self, from: data))?.message
            return .rejected(message: message ?? "That setup link didn't work. Ask a parent for a new one.")
        default:
            throw UnexpectedStatus(code: http.statusCode)
        }
    }
}
