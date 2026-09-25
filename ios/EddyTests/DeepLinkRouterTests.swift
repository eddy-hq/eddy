import XCTest
@testable import Eddy

final class DeepLinkRouterTests: XCTestCase {
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"

    private func parse(_ string: String) -> DeepLink? {
        DeepLinkRouter.parse(URL(string: string)!)
    }

    private func path(_ string: String) -> String? {
        guard case .route(let path, _)? = parse(string) else { return nil }
        return path
    }

    private func query(_ string: String) -> [URLQueryItem] {
        guard case .route(_, let query)? = parse(string) else { return [] }
        return query
    }

    // MARK: - Paths mirror the web routes

    func testLeafRoutes() {
        XCTAssertEqual(path("eddy://feed"), "/feed")
        XCTAssertEqual(path("eddy://saved"), "/saved")
        XCTAssertEqual(path("eddy://search"), "/search")
        XCTAssertEqual(path("eddy://profile"), "/profile")
        XCTAssertEqual(path("eddy://request"), "/request")
        XCTAssertEqual(path("eddy://admin"), "/admin")
        XCTAssertEqual(path("eddy://decisions"), "/decisions")
    }

    func testParameterisedRoutes() {
        XCTAssertEqual(path("eddy://watch/abc"), "/watch/abc")
        XCTAssertEqual(path("eddy://person/018f3a7c-1b2c-7d3e-8f40-51627384950a"),
                       "/person/018f3a7c-1b2c-7d3e-8f40-51627384950a")
    }

    func testTripleSlashFormIsTheSameRoute() {
        XCTAssertEqual(path("eddy:///feed"), "/feed")
        XCTAssertEqual(path("eddy:///watch/abc"), "/watch/abc")
    }

    func testCaseInsensitiveSchemeAndRoot() {
        XCTAssertEqual(path("EDDY://FEED"), "/feed")
    }

    func testTrailingSlashIsIgnored() {
        XCTAssertEqual(path("eddy://feed/"), "/feed")
        XCTAssertEqual(path("eddy://watch/abc/"), "/watch/abc")
    }

    // MARK: - Fallbacks

    func testUnknownRoutesFallBackToTheFeed() {
        XCTAssertEqual(path("eddy://nonsense"), "/feed")
        XCTAssertEqual(path("eddy://feed/extra/segments"), "/feed")
        XCTAssertEqual(path("eddy://watch"), "/feed", "a watch link with no id is not a route")
        XCTAssertEqual(path("eddy://person/"), "/feed")
        XCTAssertEqual(path("eddy://"), "/feed")
    }

    func testNonEddySchemesAreNotOurs() {
        XCTAssertNil(parse("https://eddyhq.app/feed"))
        XCTAssertNil(parse("shortcuts://run-shortcut"))
    }

    // MARK: - Query handling

    func testExtraQueryItemsSurvive() {
        XCTAssertEqual(query("eddy://watch/abc?t=30&from=push"),
                       [URLQueryItem(name: "t", value: "30"),
                        URLQueryItem(name: "from", value: "push")])
    }

    func testQueryItemsSurviveTheFallback() {
        XCTAssertEqual(query("eddy://nonsense?t=30"), [URLQueryItem(name: "t", value: "30")])
    }

    /// The shell owns identity. A link must not be able to hand the app a
    /// different user's id by smuggling it through a route.
    func testIdentityParametersAreStrippedFromRoutes() {
        XCTAssertEqual(query("eddy://feed?userId=\(userId)&t=1"), [URLQueryItem(name: "t", value: "1")])
        XCTAssertEqual(query("eddy://feed?user=\(userId)"), [])
        XCTAssertEqual(query("eddy://feed?USERID=\(userId)"), [])
    }

    // MARK: - Setup links

    func testSetupLinkCarriesAnIdentityClaim() {
        XCTAssertEqual(parse("eddy://setup?userId=\(userId)"), .setup(userId: userId))
        XCTAssertEqual(parse("eddy://setup?user=\(userId)"), .setup(userId: userId))
    }

    func testSetupLinkNormalisesCase() {
        XCTAssertEqual(parse("eddy://setup?userId=\(userId.uppercased())"), .setup(userId: userId))
    }

    func testSetupLinkWithoutAUsableIdIsJustTheFeed() {
        XCTAssertEqual(path("eddy://setup"), "/feed")
        XCTAssertEqual(path("eddy://setup?userId=not-a-uuid"), "/feed")
    }
}
