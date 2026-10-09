import XCTest
@testable import Eddy

private let enrolledUserId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"
private let enrolledCredential = String(repeating: "c", count: 43)

private struct StubEnroller: DeviceEnroller {
    enum Outcome: Sendable {
        case enrols
        case refuses
        case offline
    }

    struct Offline: Error {}

    let outcome: Outcome

    func enrol(invite: String, base: URL, deviceType: String) async throws -> EnrolmentOutcome {
        switch outcome {
        case .enrols: .enrolled(DeviceIdentity(userId: enrolledUserId, credential: enrolledCredential))
        case .refuses: .rejected(message: "This setup link has expired")
        case .offline: throw Offline()
        }
    }
}

@MainActor
final class ShellModelTests: XCTestCase {
    private let userId = enrolledUserId
    private let identity = DeviceIdentity(userId: enrolledUserId, credential: enrolledCredential)
    private let invite = "ZW5yb2w6eDox." + String(repeating: "ab", count: 32)
    private let config = try! AppConfig(baseURLString: "https://eddy.example.com", version: "1.0 (1)")

    private func model(
        seed: DeviceIdentity? = nil,
        enroller: StubEnroller.Outcome = .enrols,
        loadTimeout: Duration = .seconds(20)
    ) -> ShellModel {
        ShellModel(
            config: config,
            identity: InMemoryIdentityStore(seed: seed),
            enroller: StubEnroller(outcome: enroller),
            loadTimeout: loadTimeout
        )
    }

    func testFirstLaunchAsksForSetup() {
        let model = model()
        XCTAssertEqual(model.state, .setup)
        XCTAssertNil(model.userId)
        XCTAssertNil(model.bridgeScript)
    }

    func testAKnownIdentitySkipsSetupAndLoadsTheFeed() {
        let model = model(seed: identity)
        XCTAssertEqual(model.state, .loading)
        model.start()
        XCTAssertEqual(model.pendingLoad?.url.absoluteString,
                       "https://eddy.example.com/feed?userId=\(userId)")
    }

    func testSetupRedeemsTheInviteBeforeSaving() async {
        let model = model(enroller: .enrols)
        let result = await model.completeSetup(with: "https://eddy.example/setup?invite=\(invite)")
        XCTAssertEqual(result, .ok)
        XCTAssertEqual(model.identity, identity)
        XCTAssertEqual(model.credential, enrolledCredential)
        XCTAssertEqual(model.state, .loading)
        XCTAssertNotNil(model.pendingLoad)
    }

    func testSetupPassesOnTheServersRefusal() async {
        let model = model(enroller: .refuses)
        let result = await model.completeSetup(with: invite)
        XCTAssertEqual(result, .rejected("This setup link has expired"))
        XCTAssertNil(model.userId)
        XCTAssertEqual(model.state, .setup)
    }

    func testSetupSaysUnreachableWhenTheServerCannotBeAsked() async {
        let model = model(enroller: .offline)
        let result = await model.completeSetup(with: invite)
        XCTAssertEqual(result, .unreachable)
        XCTAssertNil(model.userId)
    }

    func testSetupRejectsJunkWithoutAskingTheServer() async {
        let model = model(enroller: .offline)
        let result = await model.completeSetup(with: "hello")
        XCTAssertEqual(result, .invalidInput)
    }

    /// The old setup link carried only a user id, which proves nothing.
    func testSetupRefusesAUserIdLink() async {
        let model = model(enroller: .enrols)
        let result = await model.completeSetup(with: "https://eddy.example/feed?userId=\(userId)")
        XCTAssertEqual(result, .invalidInput)
        XCTAssertNil(model.identity)
    }

    /// An install from before enrolment kept a userId and nothing else. It
    /// must land on setup, not load the PWA with a claim the server refuses.
    func testAStoredUserIdWithoutACredentialIsNotAnIdentity() {
        let model = model(seed: DeviceIdentity(userId: userId, credential: ""))
        XCTAssertEqual(model.state, .setup)
        XCTAssertNil(model.identity)
    }

    func testClearingIdentityReturnsToSetup() {
        let model = model(seed: identity)
        model.start()
        model.clearIdentity()
        XCTAssertEqual(model.state, .setup)
        XCTAssertNil(model.userId)
        XCTAssertNil(model.pendingLoad)
        XCTAssertNil(model.bridgeScript)
    }

    func testDeepLinkLoadsTheMatchingWebRoute() {
        let model = model(seed: identity)
        model.start()
        model.handle(URL(string: "eddy://watch/abc?t=30")!)
        XCTAssertEqual(model.pendingLoad?.url.absoluteString,
                       "https://eddy.example.com/watch/abc?t=30&userId=\(userId)")
    }

    func testDeepLinkBeforeSetupIsIgnored() {
        let model = model()
        model.handle(URL(string: "eddy://watch/abc")!)
        XCTAssertNil(model.pendingLoad)
        XCTAssertEqual(model.state, .setup)
    }

    func testForeignURLsAreIgnored() {
        let model = model(seed: identity)
        model.start()
        let before = model.pendingLoad
        model.handle(URL(string: "https://evil.example/feed")!)
        XCTAssertEqual(model.pendingLoad, before)
    }

    func testNetworkFailureRaisesTheFallbackAndRetryReloadsTheSameURL() {
        let model = model(seed: identity)
        model.start()
        let target = model.pendingLoad?.url
        model.webViewDidFail(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotFindHost))
        XCTAssertEqual(model.state, .unreachable(.network))

        model.retry()
        XCTAssertEqual(model.state, .loading)
        XCTAssertEqual(model.pendingLoad?.url, target)
    }

    func testRetryIsADistinctLoadRequestEvenForTheSameURL() {
        let model = model(seed: identity)
        model.start()
        let first = model.pendingLoad
        model.webViewDidFail(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
        model.retry()
        XCTAssertEqual(model.pendingLoad?.url, first?.url)
        XCTAssertNotEqual(model.pendingLoad?.id, first?.id)
    }

    func testAnHTTPErrorPageIsNotUnreachable() {
        let model = model(seed: identity)
        model.start()
        model.webViewDidFinishLoad()
        model.webViewDidFail(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
        XCTAssertEqual(model.state, .loaded)
    }

    func testForegroundingRetriesOnlyFromTheFallbackScreen() {
        let model = model(seed: identity)
        model.start()
        model.webViewDidFinishLoad()
        model.enteredForeground()
        XCTAssertEqual(model.state, .loaded)

        model.webViewDidFail(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost))
        model.enteredForeground()
        XCTAssertEqual(model.state, .loading)
    }

    func testDeepLinkTakesDownTheFallbackScreen() {
        // The web host isn't on screen while unreachable, so nothing else can
        // report that a load has started.
        let model = model(seed: identity)
        model.start()
        model.webViewDidFail(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotFindHost))
        XCTAssertEqual(model.state, .unreachable(.network))

        model.handle(URL(string: "eddy://saved")!)
        XCTAssertEqual(model.state, .loading)
        XCTAssertEqual(model.pendingLoad?.url.absoluteString,
                       "https://eddy.example.com/saved?userId=\(userId)")
    }

    func testAFirstLoadThatNeverAnswersTimesOut() async throws {
        let model = model(seed: identity, loadTimeout: .milliseconds(20))
        model.start()
        model.webViewDidStartLoad()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(model.state, .unreachable(.timeout))
    }

    func testTheWatchdogStopsOnceThePageLoads() async throws {
        let model = model(seed: identity, loadTimeout: .milliseconds(20))
        model.start()
        model.webViewDidStartLoad()
        model.webViewDidFinishLoad()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(model.state, .loaded)
    }

    func testInPageNavigationOnALoadedShellIsNotWatchdogged() async throws {
        // Timing out an in-page navigation would blank a working app.
        let model = model(seed: identity, loadTimeout: .milliseconds(20))
        model.start()
        model.webViewDidStartLoad()
        model.webViewDidFinishLoad()
        model.webViewDidStartLoad()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(model.state, .loaded)
    }

    func testResetIsConfirmedBeforeAnythingIsCleared() {
        let model = model(seed: identity)
        model.start()
        model.requestIdentityReset()
        XCTAssertTrue(model.isConfirmingReset)
        XCTAssertEqual(model.userId, userId)

        model.clearIdentity()
        XCTAssertFalse(model.isConfirmingReset)
        XCTAssertEqual(model.state, .setup)
    }

    func testResetIsNotOfferedBeforeSetup() {
        let model = model()
        model.requestIdentityReset()
        XCTAssertFalse(model.isConfirmingReset)
    }

    /// Cold launch through a deep link: SwiftUI may deliver the URL before the
    /// opening task runs, and the web host only loads the latest request.
    func testADeepLinkDeliveredBeforeStartSurvivesIt() {
        let model = model(seed: identity)
        model.handle(URL(string: "eddy://watch/abc")!)
        model.start()
        XCTAssertEqual(model.pendingLoad?.url.absoluteString,
                       "https://eddy.example.com/watch/abc?userId=\(userId)")
    }

    /// A custom-scheme link is unauthenticated. It may hand an identity to a
    /// device that has none, never swap one already in place.
    func testASetupLinkCannotReIdentifyADeviceThatAlreadyHasAnIdentity() async throws {
        let already = DeviceIdentity(
            userId: "018f3a7c-1b2c-7d3e-8f40-51627384950b",
            credential: String(repeating: "d", count: 43)
        )
        let model = model(seed: already)
        model.start()
        model.handle(URL(string: "eddy://setup?invite=\(invite)")!)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(model.identity, already)
    }

    func testASetupLinkStillIdentifiesAFreshDevice() async throws {
        let model = model(enroller: .enrols)
        model.handle(URL(string: "eddy://setup?invite=\(invite)")!)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(model.userId, userId)
        XCTAssertEqual(model.state, .loading)
    }

    /// A jetsammed content process must go back through the state machine, or
    /// a failed reload leaves a blank web view with no visible way out.
    func testAContentProcessCrashRetriesThroughTheStateMachine() {
        let model = model(seed: identity)
        model.start()
        model.webViewDidStartLoad()
        model.webViewDidFinishLoad()
        let before = model.pendingLoad

        model.webContentProcessTerminated()
        XCTAssertEqual(model.state, .loading)
        XCTAssertNotEqual(model.pendingLoad?.id, before?.id)
        XCTAssertEqual(model.pendingLoad?.url, before?.url)

        model.webViewDidFail(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost))
        XCTAssertEqual(model.state, .unreachable(.network))
    }

    func testBridgeScriptCarriesTheStoredIdentity() throws {
        let model = model(seed: identity)
        let script = try XCTUnwrap(model.bridgeScript)
        XCTAssertTrue(script.contains(userId))
        XCTAssertTrue(script.contains("1.0 (1)"))
    }
}
