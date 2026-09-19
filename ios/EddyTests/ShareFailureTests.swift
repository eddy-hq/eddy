import XCTest
@testable import Eddy

final class ShareFailureTests: XCTestCase {
    func testAcceptedHasNoFailure() {
        XCTAssertNil(RequestOutcome.accepted(message: "Got it.", status: "ready").failure)
    }

    func testEveryOtherOutcomeMapsToSomethingSayable() {
        XCTAssertEqual(RequestOutcome.refused(message: "url must be a YouTube URL").failure,
                       .refused("url must be a YouTube URL"))
        XCTAssertEqual(RequestOutcome.unreachable.failure, .unreachable)
        XCTAssertEqual(RequestOutcome.serverError.failure, .serverError)
    }

    /// The server's wording is shown as-is; nothing is prefixed onto it.
    func testARefusalSaysExactlyWhatTheServerSaid() {
        let failure = ShareFailure.refused("url must be a YouTube URL")
        XCTAssertEqual(failure.detail, "url must be a YouTube URL")
        XCTAssertEqual(failure.line, "url must be a YouTube URL")
    }

    func testUnreachablePointsAtTailscale() {
        XCTAssertTrue(ShareFailure.unreachable.detail.contains("Tailscale"))
    }

    func testUnpairedPointsAtTheApp() {
        XCTAssertTrue(ShareFailure.unpaired.detail.contains("Open Eddy"))
    }

    func testEveryFailureHasBothHalvesOfTheCard() {
        let all: [ShareFailure] = [
            .refused("nope"), .unreachable, .unpaired, .nothingShareable, .serverError,
        ]
        for failure in all {
            XCTAssertFalse(failure.title.isEmpty)
            XCTAssertFalse(failure.detail.isEmpty)
            XCTAssertFalse(failure.line.isEmpty)
        }
    }
}
