import XCTest
@testable import Eddy

/// The wire shape of `POST /devices` and `DELETE /devices/{id}`. The contract
/// lives on the server; this is the half of it the shell is responsible for.
final class DeviceRegistrationTests: XCTestCase {
    private let base = URL(string: "https://eddyhq.app")!
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"
    private let deviceId = "018f3a7c-1b2c-7d3e-8f40-5162738495ff"
    private let token = String(repeating: "a", count: 64)

    private func registration(deviceId: String?) -> DeviceRegistration {
        DeviceRegistration(
            userId: userId,
            deviceId: deviceId,
            apnsToken: token,
            apnsEnvironment: PushEnvironment.production.rawValue,
            deviceType: "phone"
        )
    }

    private func body(_ registration: DeviceRegistration) throws -> [String: Any] {
        let request = try DeviceRegistrationClient(baseURL: base).makeRegisterRequest(registration)
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testRegistersAtTheDevicesEndpoint() throws {
        let request = try DeviceRegistrationClient(baseURL: base).makeRegisterRequest(registration(deviceId: nil))
        XCTAssertEqual(request.url?.absoluteString, "https://eddyhq.app/devices")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    /// No display name: the server defaults it, and what a household calls a
    /// phone is a person's name often enough (§14).
    func testSendsNoDisplayName() throws {
        let sent = try body(registration(deviceId: nil))
        XCTAssertNil(sent["displayName"])
        XCTAssertEqual(sent["userId"] as? String, userId)
        XCTAssertEqual(sent["apnsToken"] as? String, token)
        XCTAssertEqual(sent["apnsEnvironment"] as? String, "production")
        XCTAssertEqual(sent["deviceType"] as? String, "phone")
    }

    /// Omitted on a first registration; sent afterwards so one device stays
    /// one row rather than accumulating one per token.
    func testOmitsAnUnknownDeviceId() throws {
        XCTAssertNil(try body(registration(deviceId: nil))["deviceId"])
        XCTAssertEqual(try body(registration(deviceId: deviceId))["deviceId"] as? String, deviceId)
    }

    func testDeregistersAsTheOwner() throws {
        let request = try DeviceRegistrationClient(baseURL: base)
            .makeDeregisterRequest(deviceId: deviceId, userId: userId)
        XCTAssertEqual(request.url?.absoluteString, "https://eddyhq.app/devices/\(deviceId)?userId=\(userId)")
        XCTAssertEqual(request.httpMethod, "DELETE")
    }

    func testKeepsABasePathPrefix() throws {
        let request = try DeviceRegistrationClient(baseURL: URL(string: "https://home.example/eddy/")!)
            .makeRegisterRequest(registration(deviceId: nil))
        XCTAssertEqual(request.url?.path, "/eddy/devices")
    }
}
