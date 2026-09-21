import XCTest
@testable import Eddy

final class PushRegistrationLedgerTests: XCTestCase {
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"
    private let other = "018f3a7c-1b2c-7d3e-8f40-51627384950b"
    private let deviceId = "018f3a7c-1b2c-7d3e-8f40-5162738495ff"
    private let token = String(repeating: "a", count: 64)

    func testAFreshLedgerRegisters() {
        let ledger = PushRegistrationLedger()
        XCTAssertNil(ledger.deviceId)
        XCTAssertTrue(ledger.needsRegistration(userId: userId, token: token))
    }

    func testTheSameTokenAndUserIsSkipped() {
        var ledger = PushRegistrationLedger()
        ledger.recordRegistration(userId: userId, token: token, deviceId: deviceId)
        XCTAssertFalse(ledger.needsRegistration(userId: userId, token: token))
        XCTAssertEqual(ledger.deviceId, deviceId)
    }

    func testARotatedTokenRegistersAgain() {
        var ledger = PushRegistrationLedger()
        ledger.recordRegistration(userId: userId, token: token, deviceId: deviceId)
        XCTAssertTrue(ledger.needsRegistration(userId: userId, token: String(repeating: "b", count: 64)))
    }

    func testAnotherIdentityRegistersAgain() {
        var ledger = PushRegistrationLedger()
        ledger.recordRegistration(userId: userId, token: token, deviceId: deviceId)
        XCTAssertTrue(ledger.needsRegistration(userId: other, token: token))
    }

    /// A device id belongs to one identity — the server answers 404 for one
    /// owned by somebody else — so disconnecting drops it with the identity.
    func testForgettingDropsTheDeviceId() {
        var ledger = PushRegistrationLedger(deviceId: deviceId)
        ledger.recordRegistration(userId: userId, token: token, deviceId: deviceId)
        ledger.forget()
        XCTAssertNil(ledger.deviceId)
        XCTAssertTrue(ledger.needsRegistration(userId: userId, token: token))
    }

    /// The id the last launch stored is sent on the next registration, so one
    /// device stays one row.
    func testARememberedDeviceIdSurvivesALaunch() {
        let ledger = PushRegistrationLedger(deviceId: deviceId)
        XCTAssertEqual(ledger.deviceId, deviceId)
        XCTAssertTrue(ledger.needsRegistration(userId: userId, token: token))
    }
}
