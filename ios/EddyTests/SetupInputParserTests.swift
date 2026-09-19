import XCTest
@testable import Eddy

final class SetupInputParserTests: XCTestCase {
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"

    func testBareUUID() {
        XCTAssertEqual(SetupInputParser.parse(userId), userId)
    }

    func testBareUUIDIsNormalisedAndTrimmed() {
        XCTAssertEqual(SetupInputParser.parse("  \(userId.uppercased())\n"), userId)
    }

    func testPastedEddyLink() {
        XCTAssertEqual(SetupInputParser.parse("https://eddyhq.app/feed?userId=\(userId)"), userId)
    }

    func testPastedLinkWithOtherParameters() {
        XCTAssertEqual(
            SetupInputParser.parse("https://eddyhq.app/watch/abc?t=30&userId=\(userId)&x=1"),
            userId
        )
    }

    func testSetupDeepLink() {
        XCTAssertEqual(SetupInputParser.parse("eddy://setup?userId=\(userId)"), userId)
    }

    /// The PWA treats `user=` as an alias for `userId=` (BottomNav.tsx), so a
    /// link pasted from an older screen still works.
    func testUserAlias() {
        XCTAssertEqual(SetupInputParser.parse("https://eddyhq.app/feed?user=\(userId)"), userId)
    }

    func testCaseInsensitiveKey() {
        XCTAssertEqual(SetupInputParser.parse("https://eddyhq.app/feed?UserID=\(userId)"), userId)
    }

    func testLinkBuriedInSharedText() {
        XCTAssertEqual(
            SetupInputParser.parse("Here you go — https://eddyhq.app/feed?userId=\(userId) — enjoy"),
            userId
        )
    }

    func testRejectsJunk() {
        XCTAssertNil(SetupInputParser.parse(""))
        XCTAssertNil(SetupInputParser.parse("   "))
        XCTAssertNil(SetupInputParser.parse("hello"))
        XCTAssertNil(SetupInputParser.parse("https://eddyhq.app/feed"))
        XCTAssertNil(SetupInputParser.parse("userId=not-a-uuid"))
        XCTAssertNil(SetupInputParser.parse("018f3a7c1b2c7d3e8f4051627384950a"), "unhyphenated is not accepted")
    }

    func testRejectsATruncatedId() {
        XCTAssertNil(SetupInputParser.parse("018f3a7c-1b2c-7d3e-8f40-5162738495"))
    }

    /// A key that merely ends in "user" isn't the identity parameter.
    func testDoesNotMatchAPartialKey() {
        XCTAssertNil(SetupInputParser.parse("myuserid=\(userId)"))
        XCTAssertNil(SetupInputParser.parse("superuser=\(userId)"))
    }
}
