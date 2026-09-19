import XCTest
@testable import Eddy

final class ShareInputTests: XCTestCase {
    func testTakesAURLAttachment() {
        let items: [SharedItem] = [.url(URL(string: "https://youtu.be/abc")!)]
        XCTAssertEqual(ShareInput.shareableText(from: items), "https://youtu.be/abc")
    }

    /// What the YouTube app produces: a title, a link, and some promo text.
    /// The whole block goes to the server, which pulls the first URL out of it.
    func testSendsShareTextWholeWhenItHoldsALink() {
        let text = "Watch \"Some video\" on YouTube\nhttps://youtu.be/abc"
        XCTAssertEqual(ShareInput.shareableText(from: [.text(text)]), text)
    }

    func testTextWithNoLinkIsNothingToSend() {
        XCTAssertNil(ShareInput.shareableText(from: [.text("just some words")]))
        XCTAssertNil(ShareInput.shareableText(from: [.text("")]))
        // A scheme with nothing after it isn't a link.
        XCTAssertNil(ShareInput.shareableText(from: [.text("https:// ")]))
    }

    func testAURLAttachmentWinsOverTextWhateverTheOrder() {
        let items: [SharedItem] = [
            .text("Watch this https://youtu.be/from-text"),
            .url(URL(string: "https://youtu.be/from-url")!),
        ]
        XCTAssertEqual(ShareInput.shareableText(from: items), "https://youtu.be/from-url")
    }

    func testFallsBackToTextWhenTheURLIsNotAWebLink() {
        let items: [SharedItem] = [
            .url(URL(string: "file:///var/tmp/thing.mp4")!),
            .text("Watch this https://youtu.be/abc"),
        ]
        XCTAssertEqual(ShareInput.shareableText(from: items), "Watch this https://youtu.be/abc")
    }

    func testNothingSharedIsNothingToSend() {
        XCTAssertNil(ShareInput.shareableText(from: []))
    }

    func testSchemeMatchingIgnoresCase() {
        XCTAssertTrue(ShareInput.containsWebLink("HTTPS://youtu.be/abc"))
        XCTAssertTrue(ShareInput.containsWebLink("see Http://example.test/x"))
        XCTAssertFalse(ShareInput.containsWebLink("ftp://example.test/x"))
    }

    func testOnlyHTTPSchemesCountAsWebLinks() {
        XCTAssertTrue(ShareInput.isWebLink(URL(string: "http://example.test")!))
        XCTAssertTrue(ShareInput.isWebLink(URL(string: "https://example.test")!))
        XCTAssertFalse(ShareInput.isWebLink(URL(string: "eddy://watch/abc")!))
    }
}
