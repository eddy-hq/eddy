import XCTest
@testable import Eddy

private struct StubVerifier: IdentityVerifier {
    enum Outcome: Sendable {
        case known
        case unknown
        case offline
    }

    struct Offline: Error {}

    let outcome: Outcome

    func verify(userId: String, base: URL) async throws -> IdentityVerification {
        switch outcome {
        case .known: .known
        case .unknown: .unknown
        case .offline: throw Offline()
        }
    }
}

@MainActor
final class ShellModelTests: XCTestCase {
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"
    private let config = try! AppConfig(baseURLString: "https://eddyhq.app", version: "1.0 (1)")

    private func model(
        seed: String? = nil,
        verifier: StubVerifier.Outcome = .known,
        loadTimeout: Duration = .seconds(20)
    ) -> ShellModel {
        ShellModel(
            config: config,
            identity: InMemoryIdentityStore(seed: seed),
            verifier: StubVerifier(outcome: verifier),
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
        let model = model(seed: userId)
        XCTAssertEqual(model.state, .loading)
        model.start()
        XCTAssertEqual(model.pendingLoad?.url.absoluteString,
                       "https://eddyhq.app/feed?userId=\(userId)")
    }

    func testSetupVerifiesBeforeSaving() async {
        let model = model(verifier: .known)
        let result = await model.completeSetup(with: "https://eddyhq.app/feed?userId=\(userId)")
        XCTAssertEqual(result, .ok)
        XCTAssertEqual(model.userId, userId)
        XCTAssertEqual(model.state, .loading)
        XCTAssertNotNil(model.pendingLoad)
    }

    func testSetupRejectsAnUnknownUser() async {
        let model = model(verifier: .unknown)
        let result = await model.completeSetup(with: userId)
        XCTAssertEqual(result, .unknownUser)
        XCTAssertNil(model.userId)
        XCTAssertEqual(model.state, .setup)
    }

    func testSetupSaysUnreachableWhenTheServerCannotBeAsked() async {
        let model = model(verifier: .offline)
        let result = await model.completeSetup(with: userId)
        XCTAssertEqual(result, .unreachable)
        XCTAssertNil(model.userId)
    }

    func testSetupRejectsJunkWithoutAskingTheServer() async {
        let model = model(verifier: .offline)
        let result = await model.completeSetup(with: "hello")
        XCTAssertEqual(result, .invalidInput)
    }

    func testClearingIdentityReturnsToSetup() {
        let model = model(seed: userId)
        model.start()
        model.clearIdentity()
        XCTAssertEqual(model.state, .setup)
        XCTAssertNil(model.userId)
        XCTAssertNil(model.pendingLoad)
        XCTAssertNil(model.bridgeScript)
    }

    func testDeepLinkLoadsTheMatchingWebRoute() {
        let model = model(seed: userId)
        model.start()
        model.handle(URL(string: "eddy://watch/abc?t=30")!)
        XCTAssertEqual(model.pendingLoad?.url.absoluteString,
                       "https://eddyhq.app/watch/abc?t=30&userId=\(userId)")
    }

    func testDeepLinkBeforeSetupIsIgnored() {
        let model = model()
        model.handle(URL(string: "eddy://watch/abc")!)
        XCTAssertNil(model.pendingLoad)
        XCTAssertEqual(model.state, .setup)
    }

    func testForeignURLsAreIgnored() {
        let model = model(seed: userId)
        model.start()
        let before = model.pendingLoad
        model.handle(URL(string: "https://evil.example/feed")!)
        XCTAssertEqual(model.pendingLoad, before)
    }

    func testNetworkFailureRaisesTheFallbackAndRetryReloadsTheSameURL() {
        let model = model(seed: userId)
        model.start()
        let target = model.pendingLoad?.url
        model.webViewDidFail(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotFindHost))
        XCTAssertEqual(model.state, .unreachable(.network))

        model.retry()
        XCTAssertEqual(model.state, .loading)
        XCTAssertEqual(model.pendingLoad?.url, target)
    }

    func testRetryIsADistinctLoadRequestEvenForTheSameURL() {
        let model = model(seed: userId)
        model.start()
        let first = model.pendingLoad
        model.webViewDidFail(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
        model.retry()
        XCTAssertEqual(model.pendingLoad?.url, first?.url)
        XCTAssertNotEqual(model.pendingLoad?.id, first?.id)
    }

    func testAnHTTPErrorPageIsNotUnreachable() {
        let model = model(seed: userId)
        model.start()
        model.webViewDidFinishLoad()
        model.webViewDidFail(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
        XCTAssertEqual(model.state, .loaded)
    }

    func testForegroundingRetriesOnlyFromTheFallbackScreen() {
        let model = model(seed: userId)
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
        let model = model(seed: userId)
        model.start()
        model.webViewDidFail(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotFindHost))
        XCTAssertEqual(model.state, .unreachable(.network))

        model.handle(URL(string: "eddy://saved")!)
        XCTAssertEqual(model.state, .loading)
        XCTAssertEqual(model.pendingLoad?.url.absoluteString,
                       "https://eddyhq.app/saved?userId=\(userId)")
    }

    func testAFirstLoadThatNeverAnswersTimesOut() async throws {
        let model = model(seed: userId, loadTimeout: .milliseconds(20))
        model.start()
        model.webViewDidStartLoad()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(model.state, .unreachable(.timeout))
    }

    func testTheWatchdogStopsOnceThePageLoads() async throws {
        let model = model(seed: userId, loadTimeout: .milliseconds(20))
        model.start()
        model.webViewDidStartLoad()
        model.webViewDidFinishLoad()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(model.state, .loaded)
    }

    func testInPageNavigationOnALoadedShellIsNotWatchdogged() async throws {
        // Timing out an in-page navigation would blank a working app.
        let model = model(seed: userId, loadTimeout: .milliseconds(20))
        model.start()
        model.webViewDidStartLoad()
        model.webViewDidFinishLoad()
        model.webViewDidStartLoad()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(model.state, .loaded)
    }

    func testResetIsConfirmedBeforeAnythingIsCleared() {
        let model = model(seed: userId)
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
        let model = model(seed: userId)
        model.handle(URL(string: "eddy://watch/abc")!)
        model.start()
        XCTAssertEqual(model.pendingLoad?.url.absoluteString,
                       "https://eddyhq.app/watch/abc?userId=\(userId)")
    }

    /// A custom-scheme link is unauthenticated. It may hand an identity to a
    /// device that has none, never swap one already in place.
    func testASetupLinkCannotReIdentifyADeviceThatAlreadyHasAnIdentity() async throws {
        let other = "018f3a7c-1b2c-7d3e-8f40-51627384950b"
        let model = model(seed: userId)
        model.start()
        model.handle(URL(string: "eddy://setup?userId=\(other)")!)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(model.userId, userId)
    }

    func testASetupLinkStillIdentifiesAFreshDevice() async throws {
        let model = model(verifier: .known)
        model.handle(URL(string: "eddy://setup?userId=\(userId)")!)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(model.userId, userId)
        XCTAssertEqual(model.state, .loading)
    }

    /// A jetsammed content process must go back through the state machine, or
    /// a failed reload leaves a blank web view with no visible way out.
    func testAContentProcessCrashRetriesThroughTheStateMachine() {
        let model = model(seed: userId)
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
        let model = model(seed: userId)
        let script = try XCTUnwrap(model.bridgeScript)
        XCTAssertTrue(script.contains(userId))
        XCTAssertTrue(script.contains("1.0 (1)"))
    }
}
