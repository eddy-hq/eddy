import XCTest
@testable import Eddy

final class PushRegistrationOutcomeTests: XCTestCase {
    private let credential = String(repeating: "a", count: 43)
    private let other = String(repeating: "b", count: 43)

    func testRecordsARegistrationForTheCurrentCredential() {
        XCTAssertEqual(
            PushRegistrationOutcome.resolve(currentCredential: credential, registeredCredential: credential, deviceId: "d1"),
            .record(deviceId: "d1")
        )
    }

    func testARegistrationThatLandsAfterDisconnectIsOrphaned() {
        XCTAssertEqual(
            PushRegistrationOutcome.resolve(currentCredential: nil, registeredCredential: credential, deviceId: "d1"),
            .orphaned(deviceId: "d1")
        )
    }

    /// Disconnect and set up again — even as the same person — is a new row.
    func testARegistrationForAPreviousEnrolmentIsOrphaned() {
        XCTAssertEqual(
            PushRegistrationOutcome.resolve(currentCredential: other, registeredCredential: credential, deviceId: "d1"),
            .orphaned(deviceId: "d1")
        )
    }

    func testAFailedRequestIsNeitherRecordedNorCleanedUp() {
        XCTAssertEqual(
            PushRegistrationOutcome.resolve(currentCredential: credential, registeredCredential: credential, deviceId: nil),
            .failed
        )
    }
}
