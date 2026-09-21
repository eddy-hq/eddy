import XCTest
@testable import Eddy

final class PushMessageTests: XCTestCase {
    private let messageId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"

    /// The payload exactly as the server sends it.
    private func payload(_ m: Any?) -> [AnyHashable: Any] {
        var userInfo: [AnyHashable: Any] = [
            "aps": [
                "alert": ["title": "Eddy", "body": "Something new in Eddy"],
                "mutable-content": 1,
                "sound": "default",
            ],
        ]
        if let m { userInfo["m"] = m }
        return userInfo
    }

    func testReadsTheOpaqueId() {
        XCTAssertEqual(PushMessage.id(in: payload(messageId)), messageId)
    }

    func testNormalisesCase() {
        XCTAssertEqual(PushMessage.id(in: payload(messageId.uppercased())), messageId)
    }

    func testMissingIdIsNil() {
        XCTAssertNil(PushMessage.id(in: payload(nil)))
        XCTAssertNil(PushMessage.id(in: [:]))
    }

    /// The id goes straight into a URL path, so anything that isn't the shape
    /// the server promised is refused rather than sent.
    func testInvalidIdIsNil() {
        XCTAssertNil(PushMessage.id(in: payload("")))
        XCTAssertNil(PushMessage.id(in: payload("not-a-uuid")))
        XCTAssertNil(PushMessage.id(in: payload("../notifications/someone-else")))
        XCTAssertNil(PushMessage.id(in: payload(42)))
        XCTAssertNil(PushMessage.id(in: payload([messageId])))
    }
}
