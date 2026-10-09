import XCTest
@testable import Eddy

final class SetupInputParserTests: XCTestCase {
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"
    private let invite = "ZW5yb2w6MDE4ZjNhN2MtMWIyYy03ZDNlLThmNDAtNTE2MjczODQ5NTBhOjE3NjcyMjkyMDAwMDA."
        + String(repeating: "ab", count: 32)

    func testBareInvite() {
        XCTAssertEqual(SetupInputParser.parse(invite), invite)
    }

    func testBareInviteIsTrimmed() {
        XCTAssertEqual(SetupInputParser.parse("  \(invite)\n"), invite)
    }

    func testPastedSetupLink() {
        XCTAssertEqual(SetupInputParser.parse("https://eddy.example/setup?invite=\(invite)"), invite)
    }

    func testSetupDeepLink() {
        XCTAssertEqual(SetupInputParser.parse("eddy://setup?invite=\(invite)"), invite)
    }

    func testLinkBuriedInSharedText() {
        XCTAssertEqual(
            SetupInputParser.parse("Here you go — https://eddy.example/setup?invite=\(invite) — enjoy"),
            invite
        )
    }

    /// The old setup link carried only a user id. It is a claim, not a
    /// credential, and sets nothing up any more.
    func testRefusesAUserIdLink() {
        XCTAssertNil(SetupInputParser.parse(userId))
        XCTAssertNil(SetupInputParser.parse("https://eddy.example/feed?userId=\(userId)"))
        XCTAssertNil(SetupInputParser.parse("eddy://setup?userId=\(userId)"))
    }

    func testRejectsJunk() {
        XCTAssertNil(SetupInputParser.parse(""))
        XCTAssertNil(SetupInputParser.parse("   "))
        XCTAssertNil(SetupInputParser.parse("hello"))
        XCTAssertNil(SetupInputParser.parse("https://eddy.example/setup"))
        XCTAssertNil(SetupInputParser.parse("https://eddy.example/setup?invite=nope"))
    }

    func testRejectsATruncatedSignature() {
        XCTAssertNil(SetupInputParser.parse(String(invite.dropLast(2))))
        XCTAssertNil(SetupInputParser.parse("https://eddy.example/setup?invite=\(invite.dropLast(2))"))
    }
}
