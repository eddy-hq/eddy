import XCTest
@testable import Eddy

final class ShellStateTests: XCTestCase {
    private let all: [ShellState] = [.setup, .loading, .loaded, .unreachable(.network), .unreachable(.timeout)]

    func testFirstLaunchRunsSetupThenLoads() {
        XCTAssertEqual(ShellState.setup.next(on: .identitySaved), .loading)
        XCTAssertEqual(ShellState.loading.next(on: .loadFinished), .loaded)
    }

    func testSetupIgnoresLoadEvents() {
        for event: ShellEvent in [.loadStarted, .loadFinished, .loadFailed(.network), .retry, .foregrounded] {
            XCTAssertEqual(ShellState.setup.next(on: event), .setup, "\(event)")
        }
    }

    func testClearingIdentityAlwaysReturnsToSetup() {
        for state in all {
            XCTAssertEqual(state.next(on: .identityCleared), .setup, "\(state)")
        }
    }

    func testNetworkFailureRaisesTheFallbackScreen() {
        XCTAssertEqual(ShellState.loading.next(on: .loadFailed(.timeout)), .unreachable(.timeout))
        XCTAssertEqual(ShellState.loading.next(on: .loadFailed(.network)), .unreachable(.network))
        XCTAssertEqual(ShellState.loaded.next(on: .loadFailed(.network)), .unreachable(.network))
    }

    func testRetryFromTheFallbackScreenLoadsAgain() {
        XCTAssertEqual(ShellState.unreachable(.network).next(on: .retry), .loading)
        XCTAssertEqual(ShellState.unreachable(.timeout).next(on: .loadFinished), .loaded)
    }

    /// Someone turns Tailscale on and comes back to the app.
    func testForegroundingRetriesOnlyWhenUnreachable() {
        XCTAssertEqual(ShellState.unreachable(.network).next(on: .foregrounded), .loading)
        XCTAssertEqual(ShellState.loaded.next(on: .foregrounded), .loaded)
        XCTAssertEqual(ShellState.loading.next(on: .foregrounded), .loading)
        XCTAssertEqual(ShellState.setup.next(on: .foregrounded), .setup)
    }

    /// An in-page navigation must not flash native chrome over a live web view.
    func testInPageNavigationDoesNotLeaveLoaded() {
        XCTAssertEqual(ShellState.loaded.next(on: .loadStarted), .loaded)
        XCTAssertEqual(ShellState.loaded.next(on: .loadFinished), .loaded)
    }

    func testChangingIdentityWhileLoadedReloads() {
        XCTAssertEqual(ShellState.loaded.next(on: .identitySaved), .loading)
        XCTAssertEqual(ShellState.loaded.next(on: .retry), .loading)
    }

    func testLoadingStaysLoadingWhileItWorks() {
        XCTAssertEqual(ShellState.loading.next(on: .loadStarted), .loading)
        XCTAssertEqual(ShellState.loading.next(on: .retry), .loading)
        XCTAssertEqual(ShellState.loading.next(on: .identitySaved), .loading)
    }
}

final class LoadFailureClassifierTests: XCTestCase {
    private func classify(_ code: Int, domain: String = NSURLErrorDomain) -> UnreachableReason? {
        LoadFailureClassifier.classify(NSError(domain: domain, code: code))
    }

    func testTailscaleOffLooksLikeAnUnreachableHost() {
        XCTAssertEqual(classify(NSURLErrorCannotFindHost), .network)
        XCTAssertEqual(classify(NSURLErrorCannotConnectToHost), .network)
        XCTAssertEqual(classify(NSURLErrorDNSLookupFailed), .network)
        XCTAssertEqual(classify(NSURLErrorNotConnectedToInternet), .network)
        XCTAssertEqual(classify(NSURLErrorNetworkConnectionLost), .network)
        XCTAssertEqual(classify(NSURLErrorSecureConnectionFailed), .network)
    }

    /// A lapsed certificate on the household's own proxy, or an http base URL
    /// refused by ATS, has to report at once — not sit on a spinner until the
    /// watchdog blames Tailscale.
    func testTLSAndATSFailuresAreNetworkFailures() {
        XCTAssertEqual(classify(NSURLErrorServerCertificateHasBadDate), .network)
        XCTAssertEqual(classify(NSURLErrorServerCertificateUntrusted), .network)
        XCTAssertEqual(classify(NSURLErrorServerCertificateHasUnknownRoot), .network)
        XCTAssertEqual(classify(NSURLErrorServerCertificateNotYetValid), .network)
        XCTAssertEqual(classify(NSURLErrorAppTransportSecurityRequiresSecureConnection), .network)
    }

    func testTimeoutIsItsOwnReason() {
        XCTAssertEqual(classify(NSURLErrorTimedOut), .timeout)
    }

    /// A cancelled navigation is routine — the policy cancels off-site ones
    /// on purpose — and must never raise the fallback screen.
    func testCancellationIsNotAFailure() {
        XCTAssertNil(classify(NSURLErrorCancelled))
    }

    /// An HTTP error page comes from Eddy itself, so it never reaches here;
    /// neither does a web-content crash.
    func testNonNetworkDomainsAreIgnored() {
        XCTAssertNil(classify(NSURLErrorUnsupportedURL, domain: "WKErrorDomain"))
        XCTAssertNil(classify(404, domain: "WKErrorDomain"))
        XCTAssertNil(classify(-99999))
    }
}
