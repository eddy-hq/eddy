import os
import XCTest
@testable import Eddy

private final class EnrolTransport: HTTPTransport, @unchecked Sendable {
    private let recorded = OSAllocatedUnfairLock<URLRequest?>(initialState: nil)
    private let status: Int
    private let body: String

    var lastRequest: URLRequest? { recorded.withLock { $0 } }

    init(status: Int, body: String) {
        self.status = status
        self.body = body
    }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        recorded.withLock { $0 = request }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (Data(body.utf8), response)
    }
}

/// `POST /devices/enrol` from the shell's side (ADR-0016).
final class DeviceEnrollerTests: XCTestCase {
    private let base = URL(string: "https://eddy.example")!
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"
    private let credential = String(repeating: "c", count: 43)
    private let invite = "ZW5yb2w6eDox." + String(repeating: "ab", count: 32)

    func testAsksForTheCredentialInTheBody() async throws {
        let transport = EnrolTransport(status: 200, body: #"{"userId":"\#(userId)","credential":"\#(credential)"}"#)
        _ = try await HTTPDeviceEnroller(transport: transport).enrol(invite: invite, base: base, deviceType: "tablet")

        let request = try XCTUnwrap(transport.lastRequest)
        XCTAssertEqual(request.url?.absoluteString, "https://eddy.example/devices/enrol")
        XCTAssertEqual(request.httpMethod, "POST")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String])
        XCTAssertEqual(json, ["invite": invite, "deviceType": "tablet", "deliver": "body"])
    }

    func testAnAcceptedInviteIsAnIdentity() async throws {
        let transport = EnrolTransport(status: 200, body: #"{"userId":"\#(userId)","credential":"\#(credential)"}"#)
        let outcome = try await HTTPDeviceEnroller(transport: transport).enrol(invite: invite, base: base, deviceType: "phone")
        XCTAssertEqual(outcome, .enrolled(DeviceIdentity(userId: userId, credential: credential)))
    }

    func testARefusedInviteCarriesTheServersWords() async throws {
        let transport = EnrolTransport(status: 403, body: #"{"error":"FORBIDDEN","message":"Ask a parent for a new one."}"#)
        let outcome = try await HTTPDeviceEnroller(transport: transport).enrol(invite: invite, base: base, deviceType: "phone")
        XCTAssertEqual(outcome, .rejected(message: "Ask a parent for a new one."))
    }

    func testAServerErrorThrows() async {
        let transport = EnrolTransport(status: 500, body: "")
        do {
            _ = try await HTTPDeviceEnroller(transport: transport).enrol(invite: invite, base: base, deviceType: "phone")
            XCTFail("Expected a throw")
        } catch {}
    }

    func testAnAcceptedResponseWithoutACredentialThrows() async {
        let transport = EnrolTransport(status: 200, body: #"{"userId":"\#(userId)"}"#)
        do {
            _ = try await HTTPDeviceEnroller(transport: transport).enrol(invite: invite, base: base, deviceType: "phone")
            XCTFail("Expected a throw")
        } catch {}
    }
}

final class CredentialCookieTests: XCTestCase {
    private let credential = String(repeating: "c", count: 43)

    func testMatchesTheCookieTheServerSets() throws {
        let cookie = try XCTUnwrap(CredentialCookie.make(credential: credential, for: URL(string: "https://eddy.example/feed")!))
        XCTAssertEqual(cookie.name, "eddy_device")
        XCTAssertEqual(cookie.value, credential)
        XCTAssertEqual(cookie.domain, "eddy.example")
        XCTAssertEqual(cookie.path, "/")
        XCTAssertTrue(cookie.isSecure)
        XCTAssertTrue(cookie.isHTTPOnly)
    }

    func testIsNotSecureOverPlainHTTP() throws {
        let cookie = try XCTUnwrap(CredentialCookie.make(credential: credential, for: URL(string: "http://localhost:5173/")!))
        XCTAssertFalse(cookie.isSecure)
    }
}
