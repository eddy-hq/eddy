import XCTest
@testable import Eddy

final class NotificationTapRouterTests: XCTestCase {
    private func route(_ path: String) -> String? {
        guard let link = NotificationTapRouter.deepLink(forActionPath: path),
              case .route(let routed, _)? = DeepLinkRouter.parse(link)
        else { return nil }
        return routed
    }

    // MARK: - Web paths the server actually sends

    func testAWatchPathRoutesToTheSameWebPath() {
        XCTAssertEqual(route("/watch/abc123"), "/watch/abc123")
    }

    func testAdminRoutes() {
        XCTAssertEqual(route("/admin"), "/admin")
    }

    /// The daily Decisions nudge.
    func testDecisionsRoutes() {
        XCTAssertEqual(route("/decisions"), "/decisions")
    }

    func testAQueryIsCarried() {
        let link = NotificationTapRouter.deepLink(forActionPath: "/search?q=trains")
        guard case .route(let path, let query)? = link.flatMap(DeepLinkRouter.parse) else {
            return XCTFail("Expected a route")
        }
        XCTAssertEqual(path, "/search")
        XCTAssertEqual(query, [URLQueryItem(name: "q", value: "trains")])
    }

    func testSurroundingWhitespaceIsTolerated() {
        XCTAssertEqual(route("  /admin\n"), "/admin")
    }

    // MARK: - Anything that isn't a same-origin path

    /// Absolute URLs are refused rather than compared against the origin —
    /// Eddy's own host included. There is one shape the server sends.
    func testAbsoluteURLsAreIgnored() {
        XCTAssertNil(NotificationTapRouter.deepLink(forActionPath: "https://eddyhq.app/watch/abc"))
        XCTAssertNil(NotificationTapRouter.deepLink(forActionPath: "http://evil.example/watch/abc"))
    }

    func testProtocolRelativeURLsAreIgnored() {
        XCTAssertNil(NotificationTapRouter.deepLink(forActionPath: "//evil.example/watch/abc"))
    }

    func testOtherSchemesAreIgnored() {
        XCTAssertNil(NotificationTapRouter.deepLink(forActionPath: "javascript:alert(1)"))
        XCTAssertNil(NotificationTapRouter.deepLink(forActionPath: "eddy://watch/abc"))
        XCTAssertNil(NotificationTapRouter.deepLink(forActionPath: "file:///etc/hosts"))
    }

    func testARelativePathIsIgnored() {
        XCTAssertNil(NotificationTapRouter.deepLink(forActionPath: "watch/abc"))
        XCTAssertNil(NotificationTapRouter.deepLink(forActionPath: ""))
    }

    // MARK: - Reading it off a delivered notification

    func testReadsTheExtensionsActionURL() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Eddy", "body": "Something new in Eddy"]],
            "m": "018f3a7c-1b2c-7d3e-8f40-51627384950a",
            PushMessage.actionURLKey: "/watch/abc123",
        ]
        let link = NotificationTapRouter.deepLink(in: userInfo)
        XCTAssertEqual(link.flatMap(DeepLinkRouter.parse), .route(path: "/watch/abc123", query: []))
    }

    /// The extension's fetch failed, so nobody knows where the tap should go.
    /// Opening the app is the whole action.
    func testNoActionURLIsNoLink() {
        XCTAssertNil(NotificationTapRouter.deepLink(in: ["aps": ["alert": "Something new in Eddy"]]))
        XCTAssertNil(NotificationTapRouter.deepLink(in: [PushMessage.actionURLKey: 42]))
    }
}
