import os
import XCTest
@testable import Eddy

/// Canned answer, with the request kept so the wire shape can be asserted on.
/// Deliberately not shared with `RequestClientTests`: a test double that grows
/// options to serve two suites is worse than two small ones.
private final class IntentTransport: HTTPTransport, @unchecked Sendable {
    private let recorded = OSAllocatedUnfairLock<URLRequest?>(initialState: nil)
    private let result: Result<(Data, URLResponse), Error>

    var lastRequest: URLRequest? { recorded.withLock { $0 } }

    init(status: Int, body: String) {
        let response = HTTPURLResponse(
            url: URL(string: "https://eddyhq.app/requests")!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        result = .success((Data(body.utf8), response))
    }

    init(error: Error) {
        result = .failure(error)
    }

    /// Nothing should reach the network on a branch that fails first.
    static func mustNotBeCalled() -> IntentTransport {
        IntentTransport(error: URLError(.unsupportedURL))
    }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        recorded.withLock { $0 = request }
        return try result.get()
    }
}

final class AddToEddyTests: XCTestCase {
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"
    private let accepted = """
    {"requestId":"018f3a7c-1b2c-7d3e-8f40-51627384950b","status":"downloading",
     "message":"Got it, Boy1. Working on it.","pwaUrl":"https://eddyhq.app/feed?userId=x"}
    """

    private func config() throws -> AppConfig {
        try AppConfig(baseURLString: "https://eddyhq.app", version: "1.0 (1)")
    }

    // MARK: - The intent's own decisions

    func testReturnsTheServersMessageAsTheDialog() async throws {
        let result = await AddToEddy.run(
            link: "https://youtu.be/abc",
            userId: userId,
            config: try config(),
            transport: IntentTransport(status: 202, body: accepted)
        )
        XCTAssertEqual(try result.get(), "Got it, Boy1. Working on it.")
    }

    /// Shortcuts can pass anything, including a note with no link in it.
    func testTextWithNoLinkNeverReachesTheServer() async throws {
        let transport = IntentTransport.mustNotBeCalled()
        let result = await AddToEddy.run(
            link: "remind me about the thing",
            userId: userId,
            config: try config(),
            transport: transport
        )
        XCTAssertEqual(result.failureOrNil, .nothingShareable)
        XCTAssertNil(transport.lastRequest)
    }

    func testAnEmptyLinkIsNothingShareable() async throws {
        let result = await AddToEddy.run(
            link: "",
            userId: userId,
            config: try config(),
            transport: IntentTransport.mustNotBeCalled()
        )
        XCTAssertEqual(result.failureOrNil, .nothingShareable)
    }

    /// Text with a link is sent whole, exactly as the share extension does —
    /// the server pulls the first URL out of it.
    func testTextAroundALinkIsSentVerbatim() async throws {
        let transport = IntentTransport(status: 202, body: accepted)
        let shared = "Watch \"Some video\" on YouTube https://youtu.be/abc"
        _ = await AddToEddy.run(link: shared, userId: userId, config: try config(), transport: transport)

        let body = try XCTUnwrap(transport.lastRequest?.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["url"] as? String, shared)
        XCTAssertEqual(json["userId"] as? String, userId)
    }

    // MARK: - Failures, in the words the person sees

    func testAnUnpairedDeviceSaysToOpenEddyFirst() async throws {
        let transport = IntentTransport.mustNotBeCalled()
        let result = await AddToEddy.run(
            link: "https://youtu.be/abc",
            userId: nil,
            config: try config(),
            transport: transport
        )
        XCTAssertEqual(result.failureOrNil, .unpaired)
        XCTAssertNil(transport.lastRequest)
    }

    /// A build with an unusable `EddyBaseURL` has nowhere to send anything.
    func testNoConfigIsAServerProblemNotThePersonsFault() async {
        let result = await AddToEddy.run(
            link: "https://youtu.be/abc",
            userId: userId,
            config: nil,
            transport: IntentTransport.mustNotBeCalled()
        )
        XCTAssertEqual(result.failureOrNil, .serverError)
    }

    func testARefusalCarriesTheServersWording() async throws {
        let result = await AddToEddy.run(
            link: "https://vimeo.com/1",
            userId: userId,
            config: try config(),
            transport: IntentTransport(
                status: 400,
                body: #"{"error":"VALIDATION_ERROR","message":"url must be a YouTube URL"}"#
            )
        )
        XCTAssertEqual(result.failureOrNil, .refused("url must be a YouTube URL"))
    }

    func testAnUnknownUserCarriesTheServersWording() async throws {
        let result = await AddToEddy.run(
            link: "https://youtu.be/abc",
            userId: userId,
            config: try config(),
            transport: IntentTransport(status: 404, body: #"{"error":"NOT_FOUND","message":"user not found"}"#)
        )
        XCTAssertEqual(result.failureOrNil, .refused("user not found"))
    }

    func testTailscaleBeingDownIsUnreachable() async throws {
        let result = await AddToEddy.run(
            link: "https://youtu.be/abc",
            userId: userId,
            config: try config(),
            transport: IntentTransport(error: URLError(.cannotFindHost))
        )
        XCTAssertEqual(result.failureOrNil, .unreachable)
    }

    func testATimeoutIsUnreachable() async throws {
        let result = await AddToEddy.run(
            link: "https://youtu.be/abc",
            userId: userId,
            config: try config(),
            transport: IntentTransport(error: URLError(.timedOut))
        )
        XCTAssertEqual(result.failureOrNil, .unreachable)
    }

    // MARK: - What Shortcuts renders

    /// Shortcuts shows a thrown error's localised string and nothing else, so
    /// a refusal has to read as a whole sentence on its own.
    func testTheThrownErrorIsTheSameCopyTheCardWouldShow() {
        XCTAssertEqual(
            EddyIntentError(.refused("url must be a YouTube URL")).failure.line,
            "url must be a YouTube URL"
        )
        XCTAssertEqual(
            EddyIntentError(.unpaired).failure.line,
            "This device isn't connected. Open Eddy and paste your link, then share again."
        )
    }
}

private extension Result where Failure == ShareFailure {
    var failureOrNil: ShareFailure? {
        guard case .failure(let failure) = self else { return nil }
        return failure
    }
}
