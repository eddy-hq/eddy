import XCTest
@testable import Eddy

/// The wire shape of `POST /devices` and `DELETE /devices/me`. The contract
/// lives on the server; this is the half of it the shell is responsible for.
final class DeviceRegistrationTests: XCTestCase {
    private let base = URL(string: "https://eddy.example")!
    private let credential = String(repeating: "c", count: 43)
    private let token = String(repeating: "a", count: 64)

    private let registration = DeviceRegistration(
        apnsToken: String(repeating: "a", count: 64),
        apnsEnvironment: PushEnvironment.production.rawValue,
        deviceType: "phone"
    )

    private func body(_ registration: DeviceRegistration) throws -> [String: Any] {
        let request = try DeviceRegistrationClient(baseURL: base).makeRegisterRequest(registration, credential: credential)
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testRegistersAtTheDevicesEndpointWithTheCredential() throws {
        let request = try DeviceRegistrationClient(baseURL: base).makeRegisterRequest(registration, credential: credential)
        XCTAssertEqual(request.url?.absoluteString, "https://eddy.example/devices")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(credential)")
    }

    /// No display name: the server defaults it, and what a household calls a
    /// phone is a person's name often enough (§14). No user or device id: the
    /// credential names the row.
    func testSendsOnlyThePushIdentity() throws {
        let sent = try body(registration)
        XCTAssertEqual(Set(sent.keys), ["apnsToken", "apnsEnvironment", "deviceType"])
        XCTAssertEqual(sent["apnsToken"] as? String, token)
        XCTAssertEqual(sent["apnsEnvironment"] as? String, "production")
        XCTAssertEqual(sent["deviceType"] as? String, "phone")
    }

    func testDeregistersItsOwnRow() throws {
        let request = try DeviceRegistrationClient(baseURL: base).makeDeregisterRequest(credential: credential)
        XCTAssertEqual(request.url?.absoluteString, "https://eddy.example/devices/me")
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(credential)")
    }

    func testKeepsABasePathPrefix() throws {
        let request = try DeviceRegistrationClient(baseURL: URL(string: "https://home.example/eddy/")!)
            .makeRegisterRequest(registration, credential: credential)
        XCTAssertEqual(request.url?.path, "/eddy/devices")
    }
}
