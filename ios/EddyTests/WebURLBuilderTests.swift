import XCTest
@testable import Eddy

final class WebURLBuilderTests: XCTestCase {
    private let base = URL(string: "https://eddyhq.app")!
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"

    private func build(_ path: String, _ query: [URLQueryItem] = []) -> String? {
        WebURLBuilder.url(base: base, path: path, query: query, userId: userId)?.absoluteString
    }

    func testAlwaysAppendsTheIdentity() {
        XCTAssertEqual(build("/feed"), "https://eddyhq.app/feed?userId=\(userId)")
        XCTAssertEqual(build("/watch/abc"), "https://eddyhq.app/watch/abc?userId=\(userId)")
    }

    func testAcceptsAPathWithoutALeadingSlash() {
        XCTAssertEqual(build("feed"), "https://eddyhq.app/feed?userId=\(userId)")
    }

    func testKeepsExtraQueryItemsAndPutsIdentityLast() {
        XCTAssertEqual(
            build("/watch/abc", [URLQueryItem(name: "t", value: "30")]),
            "https://eddyhq.app/watch/abc?t=30&userId=\(userId)"
        )
    }

    func testIncomingIdentityParametersAreReplacedNotDuplicated() {
        let url = build("/feed", [
            URLQueryItem(name: "userId", value: "someone-else"),
            URLQueryItem(name: "user", value: "someone-else"),
        ])
        XCTAssertEqual(url, "https://eddyhq.app/feed?userId=\(userId)")
    }

    func testBaseWithATrailingSlashDoesNotDoubleUp() {
        let url = WebURLBuilder.url(
            base: URL(string: "https://eddyhq.app/")!, path: "/feed", userId: userId
        )
        XCTAssertEqual(url?.absoluteString, "https://eddyhq.app/feed?userId=\(userId)")
    }

    func testSelfHostedBaseWithAPortAndSubPath() {
        let url = WebURLBuilder.url(
            base: URL(string: "http://eddy.example.ts.net:8080/app")!, path: "/feed", userId: userId
        )
        XCTAssertEqual(url?.absoluteString, "http://eddy.example.ts.net:8080/app/feed?userId=\(userId)")
    }

    func testEncodesAwkwardQueryValues() {
        let url = build("/search", [URLQueryItem(name: "q", value: "lego & knex")])
        XCTAssertEqual(url, "https://eddyhq.app/search?q=lego%20%26%20knex&userId=\(userId)")
    }

    /// Every URL the built product loads is produced here, so this is the
    /// guarantee that the PWA never starts from a bare path.
    func testEveryDeepLinkRouteCarriesTheIdentity() {
        for link in ["eddy://feed", "eddy://saved", "eddy://search", "eddy://profile",
                     "eddy://request", "eddy://admin", "eddy://watch/abc",
                     "eddy://person/xyz", "eddy://nonsense", "eddy://watch/abc?t=9"] {
            guard case .route(let path, let query)? = DeepLinkRouter.parse(URL(string: link)!) else {
                return XCTFail("\(link) did not resolve to a route")
            }
            let url = WebURLBuilder.url(base: base, path: path, query: query, userId: userId)
            XCTAssertEqual(
                URLComponents(url: url!, resolvingAgainstBaseURL: false)?
                    .queryItems?.first(where: { $0.name == "userId" })?.value,
                userId,
                link
            )
        }
    }
}
