import os
import XCTest
@testable import Eddy

/// Answers a canned response (or throws), keeping the request so the wire
/// shape can be asserted on.
private final class StubTransport: HTTPTransport, @unchecked Sendable {
    private let recorded = OSAllocatedUnfairLock<URLRequest?>(initialState: nil)
    private let result: Result<(Data, URLResponse), Error>

    var lastRequest: URLRequest? { recorded.withLock { $0 } }

    init(status: Int, body: String) {
        let response = HTTPURLResponse(
            url: URL(string: "https://eddy.example/notifications/x")!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        result = .success((Data(body.utf8), response))
    }

    init(error: Error) {
        result = .failure(error)
    }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        recorded.withLock { $0 = request }
        return try result.get()
    }
}

final class NotificationContentClientTests: XCTestCase {
    private let base = URL(string: "https://eddy.example")!
    private let credential = String(repeating: "c", count: 43)
    private let messageId = "018f3a7c-1b2c-7d3e-8f40-51627384950b"

    private func client(_ transport: StubTransport) -> NotificationContentClient {
        NotificationContentClient(baseURL: base, transport: transport)
    }

    // MARK: - The URL

    func testAsksForTheMessageAsTheDevicesOwnUser() throws {
        let request = try NotificationContentClient(baseURL: base)
            .makeRequest(messageId: messageId, credential: credential)
        XCTAssertEqual(request.url?.absoluteString, "https://eddy.example/notifications/\(messageId)")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(credential)")
    }

    /// A household serving Eddy under a path prefix keeps it.
    func testKeepsABasePathPrefix() throws {
        let request = try NotificationContentClient(baseURL: URL(string: "https://home.example/eddy/")!)
            .makeRequest(messageId: messageId, credential: credential)
        XCTAssertEqual(request.url?.path, "/eddy/notifications/\(messageId)")
    }

    /// iOS gives the extension seconds, not minutes, and the person is looking
    /// at the placeholder for every one of them.
    func testFetchIsBoundedAtFourSeconds() throws {
        let request = try NotificationContentClient(baseURL: base)
            .makeRequest(messageId: messageId, credential: credential)
        XCTAssertEqual(request.timeoutInterval, 4)
    }

    // MARK: - The response

    func testDecodesContent() async {
        let transport = StubTransport(status: 200, body: """
        {"title":"Eddy","body":"A request needs a look","actionUrl":"/admin"}
        """)
        let content = await client(transport).content(messageId: messageId, credential: credential)
        XCTAssertEqual(content, NotificationContent(title: "Eddy", body: "A request needs a look", actionUrl: "/admin"))
    }

    func testDecodesContentWithNoActionUrl() async {
        let transport = StubTransport(status: 200, body: """
        {"title":"Eddy","body":"Something happened"}
        """)
        let content = await client(transport).content(messageId: messageId, credential: credential)
        XCTAssertEqual(content?.actionUrl, nil)
        XCTAssertEqual(content?.body, "Something happened")
    }

    // MARK: - Every failure is the same failure

    /// An expired message, or one belonging to another member of the household.
    func testNotFoundIsNoContent() async {
        let content = await client(StubTransport(status: 404, body: "{}")).content(messageId: messageId, credential: credential)
        XCTAssertNil(content)
    }

    func testServerErrorIsNoContent() async {
        let content = await client(StubTransport(status: 500, body: "")).content(messageId: messageId, credential: credential)
        XCTAssertNil(content)
    }

    func testJunkIsNoContent() async {
        let transport = StubTransport(status: 200, body: "<html>not json</html>")
        let content = await client(transport).content(messageId: messageId, credential: credential)
        XCTAssertNil(content)
    }

    func testAPartialBodyIsNoContent() async {
        let transport = StubTransport(status: 200, body: #"{"title":"Eddy"}"#)
        let content = await client(transport).content(messageId: messageId, credential: credential)
        XCTAssertNil(content)
    }

    func testAnUnreachableTailnetIsNoContent() async {
        let transport = StubTransport(error: URLError(.timedOut))
        let content = await client(transport).content(messageId: messageId, credential: credential)
        XCTAssertNil(content)
    }
}
