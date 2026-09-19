import XCTest
@testable import Eddy

final class NavigationPolicyTests: XCTestCase {
    private let origin = WebOrigin(url: URL(string: "https://eddyhq.app")!)!

    private func decide(
        _ string: String,
        mainFrame: Bool = true,
        userInitiated: Bool = true
    ) -> NavigationDecision {
        NavigationPolicy.decide(
            url: URL(string: string),
            isMainFrame: mainFrame,
            isUserInitiated: userInitiated,
            origin: origin
        )
    }

    func testAllowsTheConfiguredOrigin() {
        XCTAssertEqual(decide("https://eddyhq.app/feed?userId=x"), .allow)
        XCTAssertEqual(decide("https://eddyhq.app/watch/abc"), .allow)
        XCTAssertEqual(decide("https://eddyhq.app:443/feed"), .allow)
        XCTAssertEqual(decide("https://EDDYHQ.APP/feed"), .allow)
    }

    // MARK: - Kid safety: the web view is not a browser

    func testBlocksSubdomainAndSuffixLookAlikes() {
        for hostile in [
            "https://eddyhq.app.evil.example/feed",
            "https://evil.example/eddyhq.app",
            "https://eddyhq.app.co/feed",
            "https://notedyhq.app/feed",
            "https://sub.eddyhq.app/feed",
            "https://eddyhq.app-evil.example/",
        ] {
            XCTAssertEqual(decide(hostile, userInitiated: false), .block, hostile)
            XCTAssertEqual(decide(hostile, userInitiated: true), .openExternally, hostile)
        }
    }

    func testRefusesEmbeddedCredentialTricks() {
        for hostile in [
            "https://eddyhq.app@evil.example/feed",
            "https://eddyhq.app:pass@evil.example/feed",
            "https://user@eddyhq.app/feed",
        ] {
            XCTAssertNotEqual(decide(hostile), .allow, hostile)
        }
    }

    func testWrongSchemeOrPortIsNotTheSameOrigin() {
        XCTAssertNotEqual(decide("http://eddyhq.app/feed"), .allow)
        XCTAssertNotEqual(decide("https://eddyhq.app:8443/feed"), .allow)
    }

    func testUserTappedOffSiteLinkLeavesTheApp() {
        XCTAssertEqual(decide("https://www.youtube.com/watch?v=abc"), .openExternally)
        XCTAssertEqual(decide("mailto:someone@example.com"), .openExternally)
        XCTAssertEqual(decide("tel:+441234567890"), .openExternally)
    }

    func testScriptedOffSiteNavigationIsDroppedSilently() {
        XCTAssertEqual(decide("https://ads.example/redirect", userInitiated: false), .block)
    }

    func testDangerousSchemesAreNeverHandedToTheSystem() {
        for scheme in [
            "javascript:alert(1)",
            "data:text/html,<h1>hi</h1>",
            "file:///etc/passwd",
            "eddy://feed",
            "itms-apps://apps.apple.com/app/id1",
        ] {
            XCTAssertEqual(decide(scheme), .block, scheme)
        }
    }

    func testBlocksAboutBlankAndNilURLs() {
        XCTAssertEqual(decide("about:blank"), .block)
        XCTAssertEqual(
            NavigationPolicy.decide(url: nil, isMainFrame: true, isUserInitiated: true, origin: origin),
            .block
        )
    }

    func testSubFramesAreThePagesOwnBusiness() {
        XCTAssertEqual(decide("https://anything.example/embed", mainFrame: false), .allow)
    }

    // MARK: - Self-hosting on another origin

    func testPolicyFollowsWhateverOriginIsConfigured() {
        let selfHosted = WebOrigin(url: URL(string: "http://eddy.example.ts.net:8080")!)!
        func check(_ string: String) -> NavigationDecision {
            NavigationPolicy.decide(
                url: URL(string: string), isMainFrame: true, isUserInitiated: false, origin: selfHosted
            )
        }
        XCTAssertEqual(check("http://eddy.example.ts.net:8080/feed"), .allow)
        XCTAssertEqual(check("https://eddyhq.app/feed"), .block)
    }
}
