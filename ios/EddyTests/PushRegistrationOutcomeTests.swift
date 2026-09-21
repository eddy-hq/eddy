import XCTest
@testable import Eddy

final class PushRegistrationOutcomeTests: XCTestCase {
    private let user = "01890a5d-ac96-774b-bcce-b302099a8057"
    private let other = "01890a5d-ac96-774b-bcce-b302099a8058"

    func testRecordsARegistrationForTheCurrentIdentity() {
        XCTAssertEqual(
            PushRegistrationOutcome.resolve(currentUserId: user, registeredUserId: user, deviceId: "d1"),
            .record(deviceId: "d1")
        )
    }

    func testARegistrationThatLandsAfterDisconnectIsOrphaned() {
        XCTAssertEqual(
            PushRegistrationOutcome.resolve(currentUserId: nil, registeredUserId: user, deviceId: "d1"),
            .orphaned(deviceId: "d1")
        )
    }

    func testARegistrationForAPreviousIdentityIsOrphaned() {
        XCTAssertEqual(
            PushRegistrationOutcome.resolve(currentUserId: other, registeredUserId: user, deviceId: "d1"),
            .orphaned(deviceId: "d1")
        )
    }

    func testAFailedRequestIsNeitherRecordedNorCleanedUp() {
        XCTAssertEqual(
            PushRegistrationOutcome.resolve(currentUserId: user, registeredUserId: user, deviceId: nil),
            .failed
        )
    }
}
