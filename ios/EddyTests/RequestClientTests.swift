import os
import XCTest
@testable import Eddy

/// Answers a canned response (or throws a canned error) and keeps the request
/// it was handed, so the wire shape can be asserted on.
private final class StubTransport: HTTPTransport, @unchecked Sendable {
    private let recorded = OSAllocatedUnfairLock<URLRequest?>(initialState: nil)
    private let result: Result<(Data, URLResponse), Error>

    var lastRequest: URLRequest? {
        recorded.withLock { $0 }
    }

    init(status: Int, body: String) {
        let response = HTTPURLResponse(
            url: URL(string: "https://eddyhq.app/requests")!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        result = .success((Data(body.utf8), response))
    }

    init(error: Error) {
        result = .failure(error)
    }

    /// A response that isn't HTTP at all.
    init(nonHTTP: Void) {
        let response = URLResponse(
            url: URL(string: "https://eddyhq.app/requests")!,
            mimeType: "application/json",
            expectedContentLength: 0,
            textEncodingName: nil
        )
        result = .success((Data(), response))
    }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        recorded.withLock { $0 = request }
        return try result.get()
    }
}

final class RequestClientTests: XCTestCase {
    private let base = URL(string: "https://eddyhq.app")!
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"
    private let shared = "https://www.youtube.com/watch?v=aaaaaaaaaaa"

    private func client(_ transport: StubTransport) -> RequestClient {
        RequestClient(baseURL: base, transport: transport)
    }

    // MARK: - Outcomes

    func testAcceptsA202() async {
        let transport = StubTransport(status: 202, body: """
        {"requestId":"018f3a7c-1b2c-7d3e-8f40-51627384950b","status":"downloading",
         "message":"Got it, Boy1. Working on it.","pwaUrl":"https://eddyhq.app/feed?userId=x"}
        """)
        let outcome = await client(transport).submit(sharedText: shared, userId: userId)
        XCTAssertEqual(outcome, .accepted(message: "Got it, Boy1. Working on it.", status: "downloading"))
    }

    /// Re-sharing something already live comes back through the dedup path:
    /// same 202, same body, a `ready` status and no new download. The client
    /// has nothing to tell apart, which is the point of asserting it.
    func testDedupResponseIsJustAnotherAcceptance() async {
        let transport = StubTransport(status: 202, body: """
        {"requestId":"018f3a7c-1b2c-7d3e-8f40-51627384950b","status":"ready",
         "message":"Got it. Working on it.","pwaUrl":"https://eddyhq.app/feed?userId=x"}
        """)
        let outcome = await client(transport).submit(sharedText: shared, userId: userId)
        XCTAssertEqual(outcome, .accepted(message: "Got it. Working on it.", status: "ready"))
    }

    func testValidationErrorSurfacesTheServersWording() async {
        let transport = StubTransport(
            status: 400,
            body: #"{"error":"VALIDATION_ERROR","message":"url must be a YouTube URL"}"#
        )
        let outcome = await client(transport).submit(sharedText: "https://vimeo.com/1", userId: userId)
        XCTAssertEqual(outcome, .refused(message: "url must be a YouTube URL"))
    }

    func testUnknownUserSurfacesTheServersWording() async {
        let transport = StubTransport(status: 404, body: #"{"error":"NOT_FOUND","message":"user not found"}"#)
        let outcome = await client(transport).submit(sharedText: shared, userId: userId)
        XCTAssertEqual(outcome, .refused(message: "user not found"))
    }

    func testServerErrorIsNotShownAsTheUsersFault() async {
        let transport = StubTransport(status: 500, body: #"{"error":"INTERNAL_ERROR","message":"Something went wrong"}"#)
        let outcome = await client(transport).submit(sharedText: shared, userId: userId)
        XCTAssertEqual(outcome, .serverError)
    }

    func testMalformedSuccessBodyIsAServerError() async {
        let transport = StubTransport(status: 202, body: "not json at all")
        let outcome = await client(transport).submit(sharedText: shared, userId: userId)
        XCTAssertEqual(outcome, .serverError)
    }

    func testMalformedFailureBodyIsAServerError() async {
        let transport = StubTransport(status: 400, body: "<html>nope</html>")
        let outcome = await client(transport).submit(sharedText: shared, userId: userId)
        XCTAssertEqual(outcome, .serverError)
    }

    func testNonHTTPResponseIsAServerError() async {
        let outcome = await client(StubTransport(nonHTTP: ())).submit(sharedText: shared, userId: userId)
        XCTAssertEqual(outcome, .serverError)
    }

    func testNetworkFailureIsUnreachable() async {
        let transport = StubTransport(error: URLError(.notConnectedToInternet))
        let outcome = await client(transport).submit(sharedText: shared, userId: userId)
        XCTAssertEqual(outcome, .unreachable)
    }

    func testTimeoutIsUnreachable() async {
        let transport = StubTransport(error: URLError(.timedOut))
        let outcome = await client(transport).submit(sharedText: shared, userId: userId)
        XCTAssertEqual(outcome, .unreachable)
    }

    // MARK: - Wire shape

    func testBodyIsExactlyUrlAndUserId() async throws {
        let transport = StubTransport(status: 202, body: """
        {"requestId":"r","status":"downloading","message":"Got it.","pwaUrl":"https://eddyhq.app/feed"}
        """)
        _ = await client(transport).submit(sharedText: "Look at this https://youtu.be/abc", userId: userId)

        let body = try XCTUnwrap(transport.lastRequest?.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["url", "userId"])
        XCTAssertEqual(json["url"] as? String, "Look at this https://youtu.be/abc")
        XCTAssertEqual(json["userId"] as? String, userId)
    }

    func testPostsToRequestsWithAGenerousTimeout() async {
        let transport = StubTransport(status: 202, body: """
        {"requestId":"r","status":"downloading","message":"Got it.","pwaUrl":"https://eddyhq.app/feed"}
        """)
        _ = await client(transport).submit(sharedText: shared, userId: userId)

        XCTAssertEqual(transport.lastRequest?.url?.absoluteString, "https://eddyhq.app/requests")
        XCTAssertEqual(transport.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(transport.lastRequest?.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(transport.lastRequest?.timeoutInterval, 20)
    }

    /// A household serving Eddy under a path prefix keeps it.
    func testKeepsABasePathPrefix() throws {
        let client = RequestClient(baseURL: URL(string: "https://home.example.ts.net/eddy/")!)
        let request = try client.makeRequest(sharedText: shared, userId: userId)
        XCTAssertEqual(request.url?.absoluteString, "https://home.example.ts.net/eddy/requests")
    }
}
