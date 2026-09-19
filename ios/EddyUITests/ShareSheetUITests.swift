import XCTest

/// The one thing unit tests cannot answer: does Eddy actually turn up in a
/// real share sheet, and can the extension — a separate process — read the
/// identity the app put in the shared keychain?
///
/// Run by hand, never in the fast suite. It needs:
///   - a user id, passed as `TEST_RUNNER_EDDY_TEST_USER_ID=<uuid>` so no real
///     id is ever written into the repo, and
///   - a build pointed at an unroutable host
///     (`EDDY_BASE_URL=https://eddy-offline.invalid`), so tapping Eddy proves
///     the identity read and the card, without sending anything anywhere.
/// The expected end state is the card's "Can't reach Eddy" — which is only
/// reachable *after* the extension has found the userId.
@MainActor
final class ShareSheetUITests: XCTestCase {
    private let videoURL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    override func setUp() {
        continueAfterFailure = false
    }

    func testEddyAppearsInSafarisShareSheetAndReadsTheAppsIdentity() throws {
        let environment = ProcessInfo.processInfo.environment
        // This flag is the operator declaring the build is offline, not proof
        // that it is: the test process cannot read the app's EddyBaseURL. The
        // two have to be set together, which is what
        // `ios/scripts/uitest-share-offline.sh` exists to guarantee — run it
        // rather than assembling the xcodebuild line by hand.
        guard environment["EDDY_TEST_OFFLINE"] == "1" else {
            throw XCTSkip("Run ios/scripts/uitest-share-offline.sh — this test taps Eddy in the share sheet.")
        }
        let userId = try XCTUnwrap(
            environment["EDDY_TEST_USER_ID"],
            "Pass TEST_RUNNER_EDDY_TEST_USER_ID=<uuid> to xcodebuild"
        )

        pairTheApp(userId: userId)

        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.launch()
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 30), "Safari didn't come up")

        open(videoURL, in: safari)
        openShareSheet(in: safari)

        let eddy = shareSheetEntry(in: safari)
        XCTAssertTrue(eddy.exists, "Eddy is not in the share sheet.\n\(safari.debugDescription)")
        attach(safari, named: "share-sheet")

        eddy.tap()

        // The card's own wording. Reaching it at all means the extension read
        // the app's keychain item — an unpaired device says so instead.
        let card = safari.staticTexts["Can't reach Eddy"]
        let unpaired = safari.staticTexts["This device isn't connected"]
        let appeared = card.waitForExistence(timeout: 40)
        attach(safari, named: "share-card")
        XCTAssertFalse(unpaired.exists, "The extension could not read the app's keychain item")
        XCTAssertTrue(appeared, "No share card appeared.\n\(safari.debugDescription)")

        let close = safari.buttons["Close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "A failed card must keep a way out")
        close.tap()
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 10), "The extension didn't dismiss")
    }

    // MARK: - Steps

    /// The DEBUG `-eddyUserId` seed writes through to the shared keychain, so
    /// one launch of the app is all the pairing the extension needs.
    private func pairTheApp(userId: String) {
        let app = XCUIApplication(bundleIdentifier: "app.eddyhq.Eddy")
        app.launchArguments = ["-eddyUserId", userId]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "Eddy didn't launch")
        attach(app, named: "app-paired")
        app.terminate()
    }

    private func open(_ url: String, in safari: XCUIApplication) {
        let field = safari.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 20), "No address field.\n\(safari.debugDescription)")
        field.tap()
        safari.typeText(url + "\n")
        // The page itself doesn't matter — Safari shares the address either
        // way — but the toolbar only settles once the load has started.
        _ = safari.buttons.firstMatch.waitForExistence(timeout: 30)
        sleep(6)
    }

    /// iOS 26 Safari keeps Share behind the toolbar's "More" menu; the web
    /// page has its own Share button, so both steps go by identifier.
    private func openShareSheet(in safari: XCUIApplication) {
        let more = safari.buttons["MoreMenuButton"]
        XCTAssertTrue(more.waitForExistence(timeout: 20), "No Safari More menu.\n\(safari.debugDescription)")
        more.tap()

        let share = safari.buttons["ShareButton"]
        XCTAssertTrue(share.waitForExistence(timeout: 10), "No Share item.\n\(safari.debugDescription)")
        share.tap()
    }

    /// Eddy sits in the activity row with the other apps, which scrolls.
    private func shareSheetEntry(in safari: XCUIApplication) -> XCUIElement {
        let byLabel = safari.descendants(matching: .any).matching(identifier: "Eddy").firstMatch
        if byLabel.waitForExistence(timeout: 15) { return byLabel }
        return safari.staticTexts["Eddy"].firstMatch
    }

    private func attach(_ app: XCUIApplication, named name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
