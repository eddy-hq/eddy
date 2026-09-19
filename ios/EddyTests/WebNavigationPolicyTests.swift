import WebKit
import XCTest
@testable import Eddy

final class WebNavigationPolicyTests: XCTestCase {
    private let origin = WebOrigin(url: URL(string: "https://eddyhq.app")!)!

    private func decide(
        _ string: String,
        type: WKNavigationType = .linkActivated,
        mainFrame: Bool = true,
        newWindow: Bool = false
    ) -> WebNavigationPolicy.Outcome {
        WebNavigationPolicy.decide(
            .init(
                url: URL(string: string),
                navigationType: type,
                targetIsMainFrame: mainFrame,
                opensNewWindow: newWindow
            ),
            origin: origin
        )
    }

    func testOnOriginNavigationIsAllowed() {
        XCTAssertEqual(decide("https://eddyhq.app/feed?userId=x"), .allow)
        XCTAssertEqual(decide("https://eddyhq.app/watch/abc", type: .backForward), .allow)
        XCTAssertEqual(decide("https://eddyhq.app/saved", type: .other), .allow)
    }

    func testTappedOffSiteLinkLeavesTheApp() {
        XCTAssertEqual(
            decide("https://www.youtube.com/watch?v=abc"),
            .openExternally(URL(string: "https://www.youtube.com/watch?v=abc")!)
        )
    }

    func testScriptedOffSiteNavigationIsDroppedSilently() {
        // The boundary that matters: a page can't walk the web view off-origin
        // on its own, only a person can send a link out of the app.
        XCTAssertEqual(decide("https://www.youtube.com/watch?v=abc", type: .other), .block)
        XCTAssertEqual(decide("https://eddyhq.app.evil.example/", type: .other), .block)
    }

    func testDangerousSchemesAreNeverHandedToTheSystem() {
        for hostile in ["javascript:alert(1)", "data:text/html,<b>x", "file:///etc/passwd", "about:blank"] {
            XCTAssertEqual(decide(hostile), .block, hostile)
        }
    }

    // MARK: - target="_blank"

    func testOnOriginNewWindowLoadsInTheExistingWebView() {
        // Never a second web view: the shell is one view, one back stack.
        XCTAssertEqual(
            decide("https://eddyhq.app/watch/abc", mainFrame: false, newWindow: true),
            .loadInPlace(URL(string: "https://eddyhq.app/watch/abc")!)
        )
    }

    func testOffSiteNewWindowIsJudgedAsATopLevelNavigation() {
        XCTAssertEqual(
            decide("https://evil.example/", mainFrame: false, newWindow: true),
            .openExternally(URL(string: "https://evil.example/")!)
        )
        XCTAssertEqual(
            decide("https://evil.example/", type: .other, mainFrame: false, newWindow: true),
            .block
        )
    }

    // MARK: - Sub-frames

    func testSubFramesAreLeftToThePage() {
        // An off-origin iframe is the trusted page's own business; blocking it
        // would break embeds without adding a boundary.
        XCTAssertEqual(decide("https://www.youtube.com/embed/abc", type: .other, mainFrame: false), .allow)
    }

    func testUserInitiatedMapping() {
        XCTAssertTrue(WebNavigationPolicy.isUserInitiated(.linkActivated))
        XCTAssertTrue(WebNavigationPolicy.isUserInitiated(.formSubmitted))
        XCTAssertTrue(WebNavigationPolicy.isUserInitiated(.backForward))
        XCTAssertFalse(WebNavigationPolicy.isUserInitiated(.other))
        XCTAssertFalse(WebNavigationPolicy.isUserInitiated(.reload))
    }
}
