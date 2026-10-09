import Foundation
import os

/// One load the web host is being asked to perform. Carries an id so that
/// retrying the same URL is still a distinct request the host can observe.
struct LoadRequest: Equatable, Identifiable, Sendable {
    let id: UUID
    let url: URL

    init(url: URL) {
        id = UUID()
        self.url = url
    }
}

enum SetupResult: Equatable {
    case ok
    /// Nothing that looked like a setup invite in what was pasted.
    case invalidInput
    /// The server answered, and refused the invite. The message is the
    /// server's, for a person.
    case rejected(String)
    /// The server couldn't be asked — almost always Tailscale.
    case unreachable
    case failed(String)
}

/// Owns identity, load state, and the URL the web host should be showing.
/// The views are thin over this; all of the decisions are in the pure types
/// it composes.
@MainActor
@Observable
final class ShellModel {
    private(set) var state: ShellState
    /// Who this device is (ADR-0016). Nil until setup has redeemed an invite —
    /// including on an install from before enrolment, which kept a userId but
    /// never had a credential.
    private(set) var identity: DeviceIdentity?
    private(set) var pendingLoad: LoadRequest?
    private(set) var isVerifying = false
    /// Raised by the hidden reset gesture; the root view turns it into an alert.
    var isConfirmingReset = false

    let config: AppConfig

    /// Push registration, once the app delegate has wired it up. Weak because
    /// the delegate owns it, and optional because the previews and the tests
    /// have no APNs at all.
    weak var push: (any PushRegistering)?

    private let identityStore: any IdentityStore
    private let enroller: any DeviceEnroller
    private let deviceType: String
    private let loadTimeout: Duration
    private var timeoutTask: Task<Void, Never>?

    init(
        config: AppConfig,
        identity: any IdentityStore,
        enroller: any DeviceEnroller,
        deviceType: String = "phone",
        loadTimeout: Duration = .seconds(20)
    ) {
        self.config = config
        self.identityStore = identity
        self.enroller = enroller
        self.deviceType = deviceType
        self.loadTimeout = loadTimeout
        let stored = identity.load()
        self.identity = stored
        state = stored == nil ? .setup : .loading
    }

    var userId: String? { identity?.userId }

    /// What the web view presents as its `eddy_device` cookie.
    var credential: String? { identity?.credential }

    /// The script injected at document start on every page.
    var bridgeScript: String? {
        userId.map { ShellBridge.userScriptSource(userId: $0, version: config.version) }
    }

    // MARK: - Lifecycle

    func start() {
        // A deep link can be delivered before the initial task runs, and the
        // web host only ever loads the latest request — so the opening load
        // must not overwrite one that has already been asked for.
        guard userId != nil, pendingLoad == nil else { return }
        load(path: DeepLinkRouter.fallbackPath)
    }

    func retry() {
        apply(.retry)
        guard let current = pendingLoad?.url else {
            load(path: DeepLinkRouter.fallbackPath)
            return
        }
        pendingLoad = LoadRequest(url: current)
    }

    func enteredForeground() {
        push?.enteredForeground()
        let before = state
        apply(.foregrounded)
        if before != state, state == .loading { retry() }
    }

    // MARK: - Web view callbacks

    func webViewDidStartLoad() {
        apply(.loadStarted)
        startTimeoutWatchdog()
    }

    func webViewDidFinishLoad() {
        timeoutTask?.cancel()
        apply(.loadFinished)
    }

    /// The content process was jetsammed. Going back through `retry` rather
    /// than reloading the web view blind keeps the state machine honest: if
    /// the reload also fails, the fallback screen and its Try again button are
    /// reachable instead of a blank web view with no way out.
    func webContentProcessTerminated() {
        Log.shell.notice("Web content process terminated")
        retry()
    }

    func webViewDidFail(_ error: Error) {
        guard let reason = LoadFailureClassifier.classify(error) else {
            Log.shell.debug("Ignoring non-network load failure: \(error.localizedDescription, privacy: .public)")
            return
        }
        timeoutTask?.cancel()
        apply(.loadFailed(reason))
    }

    // MARK: - Deep links

    func handle(_ url: URL) {
        guard let link = DeepLinkRouter.parse(url) else { return }
        switch link {
        case .setup(let invite):
            // An invite is a parent's say-so, but a custom-scheme link can
            // still arrive from anywhere. It may set up a device that has no
            // identity, never swap one that is already there — otherwise any
            // link in Messages re-points the phone at another family member,
            // guard band and all. Moving a device is Disconnect, then setup.
            guard identity == nil else {
                Log.identity.notice("Ignoring a setup link on an identified device")
                return
            }
            Task { _ = await completeSetup(with: invite) }
        case .route(let path, let query):
            guard userId != nil else { return }
            load(path: path, query: query)
        }
    }

    // MARK: - Identity

    func completeSetup(with raw: String) async -> SetupResult {
        guard let invite = SetupInputParser.parse(raw) else { return .invalidInput }

        isVerifying = true
        defer { isVerifying = false }

        let enrolled: DeviceIdentity
        do {
            switch try await enroller.enrol(invite: invite, base: config.baseURL, deviceType: deviceType) {
            case .enrolled(let identity): enrolled = identity
            case .rejected(let message): return .rejected(message)
            }
        } catch {
            Log.shell.notice("Enrolment failed: \(error.localizedDescription, privacy: .public)")
            return .unreachable
        }

        do {
            try identityStore.save(enrolled)
        } catch {
            return .failed(String(describing: error))
        }

        Log.identity.info("Device enrolled for \(enrolled.userId, privacy: .private)")
        identity = enrolled
        push?.identityAvailable(enrolled)
        apply(.identitySaved)
        load(path: DeepLinkRouter.fallbackPath)
        return .ok
    }

    func requestIdentityReset() {
        guard userId != nil else { return }
        isConfirmingReset = true
    }

    func clearIdentity() {
        isConfirmingReset = false
        timeoutTask?.cancel()
        // Before the identity goes: deleting the device row is what revokes
        // the credential, and only the credential can ask for it.
        push?.identityWillClear()
        try? identityStore.clear()
        identity = nil
        pendingLoad = nil
        apply(.identityCleared)
        Log.identity.info("Identity cleared")
    }

    // MARK: - Internals

    private func load(path: String, query: [URLQueryItem] = []) {
        guard let userId,
              let url = WebURLBuilder.url(base: config.baseURL, path: path, query: query, userId: userId)
        else { return }
        pendingLoad = LoadRequest(url: url)
        // A deep link arriving while the fallback screen is up has to take the
        // screen down itself: the web host isn't on screen to report the start.
        // On a loaded shell this is a no-op, so in-page navigation doesn't flash.
        apply(.loadStarted)
        // The path carries a video id or a person id, so it is redacted like
        // any other consumption detail.
        Log.shell.debug("Loading \(path)")
    }

    /// A load that neither finishes nor fails — the usual shape of a tailnet
    /// that's up but not routing — would otherwise spin forever.
    private func startTimeoutWatchdog() {
        timeoutTask?.cancel()
        // Only the first paint gets a watchdog. Timing out an in-page
        // navigation would blank a working app.
        guard state == .loading else { return }
        timeoutTask = Task { [weak self, loadTimeout] in
            try? await Task.sleep(for: loadTimeout)
            guard !Task.isCancelled else { return }
            self?.loadTimedOut()
        }
    }

    private func loadTimedOut() {
        guard state == .loading else { return }
        Log.shell.notice("Load timed out")
        apply(.loadFailed(.timeout))
    }

    private func apply(_ event: ShellEvent) {
        state = state.next(on: event)
    }
}
