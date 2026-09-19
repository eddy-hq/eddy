import Foundation

/// Drives the one screen the share extension has. Everything it decides with
/// lives in `Shared/` and is unit-tested from the app target; this is the
/// sequencing and nothing else.
@MainActor
@Observable
final class ShareCardModel {
    enum State: Equatable {
        case sending
        case sent(String)
        case failed(ShareFailure)
    }

    private(set) var state: State = .sending

    private let config: AppConfig?
    private let identity: any IdentityStore
    private let transport: any HTTPTransport
    private let dismissDelay: Duration
    private let finish: () -> Void

    init(
        config: AppConfig?,
        identity: any IdentityStore,
        transport: any HTTPTransport = URLSession.shared,
        dismissDelay: Duration = .milliseconds(1500),
        finish: @escaping () -> Void
    ) {
        self.config = config
        self.identity = identity
        self.transport = transport
        self.dismissDelay = dismissDelay
        self.finish = finish
    }

    func run(extensionItems: [NSExtensionItem]) async {
        let items = await ShareItemLoader.load(from: extensionItems)
        guard let sharedText = ShareInput.shareableText(from: items) else {
            state = .failed(.nothingShareable)
            return
        }

        let result = await ShareSubmission.send(
            sharedText: sharedText,
            userId: identity.load(),
            config: config,
            transport: transport
        )
        switch result {
        case .failure(let failure):
            state = .failed(failure)
        case .success(let message):
            state = .sent(message)
            // Long enough to read, short enough that the person is back in the
            // app they shared from before they've looked up.
            try? await Task.sleep(for: dismissDelay)
            finish()
        }
    }

    func close() {
        finish()
    }
}
