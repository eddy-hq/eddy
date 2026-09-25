import Foundation

/// What this device tells the server about itself. Deliberately four fields:
/// no display name (the server defaults it — what the household calls a phone
/// is a person's name often enough) and nothing that describes the person.
struct DeviceRegistration: Encodable, Equatable, Sendable {
    let userId: String
    /// The id the server handed back last time, so a re-registration updates
    /// the same row rather than accumulating one per token.
    let deviceId: String?
    let apnsToken: String
    let apnsEnvironment: String
    let deviceType: String
}

/// `POST /devices` and `DELETE /devices/{id}`. Like `RequestClient`: no state,
/// injected transport, and every failure turns into a return value rather than
/// a throw — push registration is never allowed to break the shell.
struct DeviceRegistrationClient: Sendable {
    /// Short: this runs at launch and on every foreground, and nothing waits
    /// on it, but a request still holds a connection while it hangs.
    static let defaultTimeout: TimeInterval = 10

    let baseURL: URL
    let transport: any HTTPTransport
    let timeout: TimeInterval

    init(
        baseURL: URL,
        transport: any HTTPTransport = URLSession.shared,
        timeout: TimeInterval = DeviceRegistrationClient.defaultTimeout
    ) {
        self.baseURL = baseURL
        self.transport = transport
        self.timeout = timeout
    }

    private struct Registered: Decodable {
        let deviceId: String
    }

    /// The server's device id on success, nil on any failure.
    func register(_ registration: DeviceRegistration) async -> String? {
        let request: URLRequest
        do {
            request = try makeRegisterRequest(registration)
        } catch {
            Log.push.error("Couldn't build the device registration URL")
            return nil
        }

        do {
            let (data, response) = try await transport.send(request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                Log.push.notice("Device registration answered \(status, privacy: .public)")
                return nil
            }
            guard let registered = try? JSONDecoder().decode(Registered.self, from: data) else {
                Log.push.error("Device registration response didn't parse")
                return nil
            }
            return registered.deviceId
        } catch {
            Log.push.notice("Device registration failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Best effort by design: the caller is on its way to forgetting the
    /// identity and cannot usefully wait or retry. A device the server keeps
    /// pushing to stops being reachable at the next token rotation anyway.
    func deregister(deviceId: String, userId: String) async {
        guard let request = try? makeDeregisterRequest(deviceId: deviceId, userId: userId) else {
            Log.push.error("Couldn't build the device removal URL")
            return
        }
        do {
            _ = try await transport.send(request)
        } catch {
            Log.push.notice("Device removal failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Wire shape

    func makeRegisterRequest(_ registration: DeviceRegistration) throws -> URLRequest {
        var request = URLRequest(url: try devicesURL(path: nil, userId: nil))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpBody = try JSONEncoder().encode(registration)
        return request
    }

    func makeDeregisterRequest(deviceId: String, userId: String) throws -> URLRequest {
        var request = URLRequest(url: try devicesURL(path: deviceId, userId: userId))
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    /// Built from components so a base URL with a path prefix keeps it.
    private func devicesURL(path: String?, userId: String?) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw URLError(.badURL)
        }
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = basePath + "/devices" + (path.map { "/" + $0 } ?? "")
        components.queryItems = userId.map { [URLQueryItem(name: WebURLBuilder.userIdKey, value: $0)] }
        components.fragment = nil
        guard let url = components.url else { throw URLError(.badURL) }
        return url
    }
}
