import XCTest
@testable import Eddy

final class ShellBridgeTests: XCTestCase {
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"

    private func decode(_ source: String) throws -> [String: String] {
        let prefix = "window.__EDDY_SHELL__ = Object.freeze("
        XCTAssertTrue(source.hasPrefix(prefix), source)
        XCTAssertTrue(source.hasSuffix(");"), source)
        let json = String(source.dropFirst(prefix.count).dropLast(2))
        let object = try JSONSerialization.jsonObject(with: Data(json.utf8))
        return try XCTUnwrap(object as? [String: String])
    }

    func testExposesIdentityAndVersion() throws {
        let decoded = try decode(ShellBridge.userScriptSource(userId: userId, version: "1.0 (7)"))
        XCTAssertEqual(decoded, ["userId": userId, "version": "1.0 (7)"])
    }

    /// The values are interpolated into a JavaScript statement, so anything
    /// quote-shaped has to survive as data rather than become code.
    func testEscapesValuesThatWouldBreakTheStatement() throws {
        let hostile = "a\"});alert(1);x=\""
        let decoded = try decode(ShellBridge.userScriptSource(userId: hostile, version: "1"))
        XCTAssertEqual(decoded["userId"], hostile)
    }

    func testEscapesJavaScriptLineTerminators() throws {
        let source = ShellBridge.userScriptSource(userId: userId, version: "1\u{2028}2")
        XCTAssertFalse(source.contains("\u{2028}"))
        XCTAssertTrue(source.contains("\\u2028"))
        XCTAssertEqual(try decode(source)["version"], "1\u{2028}2")
    }
}
