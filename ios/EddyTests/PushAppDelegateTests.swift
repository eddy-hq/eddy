import XCTest
@testable import Eddy

private struct NeverAskedVerifier: IdentityVerifier {
    func verify(userId: String, base: URL) async throws -> IdentityVerification { .known }
}

/// The launch window: a tap that woke the app is delivered before the SwiftUI
/// side has handed the delegate a model.
@MainActor
final class PushAppDelegateTests: XCTestCase {
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"
    private let config = try! AppConfig(baseURLString: "https://eddyhq.app", version: "1.0 (1)")

    private func model() -> ShellModel {
        ShellModel(
            config: config,
            identity: InMemoryIdentityStore(seed: userId),
            verifier: NeverAskedVerifier()
        )
    }

    private func link(_ path: String) -> URL {
        guard let link = NotificationTapRouter.deepLink(forActionPath: path) else {
            fatalError("Expected \(path) to route")
        }
        return link
    }

    func testATapBeforeTheModelArrivesIsReplayed() {
        let delegate = PushAppDelegate()
        let model = model()

        delegate.follow(link("/watch/abc123"))
        XCTAssertNil(model.pendingLoad, "Nothing can load before the model is bound")

        delegate.bind(model)
        XCTAssertEqual(
            model.pendingLoad?.url.absoluteString,
            "https://eddyhq.app/watch/abc123?userId=\(userId)"
        )
    }

    /// The opening load must not overwrite the one the tap asked for.
    func testTheReplayedLinkSurvivesTheOpeningLoad() {
        let delegate = PushAppDelegate()
        let model = model()

        delegate.follow(link("/watch/abc123"))
        delegate.bind(model)
        model.start()

        XCTAssertEqual(
            model.pendingLoad?.url.absoluteString,
            "https://eddyhq.app/watch/abc123?userId=\(userId)"
        )
    }

    func testTheLaunchTapIsReplayedOnlyOnce() {
        let delegate = PushAppDelegate()
        let model = model()

        delegate.follow(link("/admin"))
        delegate.bind(model)
        let replayed = model.pendingLoad

        delegate.bind(model)
        XCTAssertEqual(model.pendingLoad, replayed, "Binding again re-navigated")
    }

    func testATapWithNowhereToGoJustOpensTheApp() {
        let delegate = PushAppDelegate()
        let model = model()

        delegate.follow(nil)
        delegate.bind(model)
        XCTAssertNil(model.pendingLoad)

        model.start()
        XCTAssertEqual(model.pendingLoad?.url.absoluteString, "https://eddyhq.app/feed?userId=\(userId)")
    }

    func testATapOnceTheModelIsBoundRoutesStraightAway() {
        let delegate = PushAppDelegate()
        let model = model()

        delegate.bind(model)
        delegate.follow(link("/admin"))
        XCTAssertEqual(model.pendingLoad?.url.absoluteString, "https://eddyhq.app/admin?userId=\(userId)")
    }
}
