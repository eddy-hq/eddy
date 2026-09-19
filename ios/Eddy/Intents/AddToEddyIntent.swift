import AppIntents
import Foundation

/// The Shortcut's replacement for anyone who liked the Shortcut. Same
/// endpoint, same identity and the same wording as the share extension —
/// ADR-0013 keeps this route alive rather than forcing everyone onto the
/// share sheet.
struct AddToEddyIntent: AppIntent {
    static let title: LocalizedStringResource = "Add to Eddy"
    static let description = IntentDescription(
        "Sends a link to Eddy. Eddy fetches the video and lets you know when it's ready."
    )
    /// The whole point is that nothing is interrupted.
    static let openAppWhenRun = false

    /// Optional so the Shortcuts tile can run with nothing filled in and ask
    /// for the link itself: a free-text parameter can't be carried by a spoken
    /// phrase, so a *required* one leaves an App Shortcut with nowhere to get
    /// a value from. Tapping the tile in the simulator still answers "Unable
    /// to run App Shortcut" either way — see README, that one is unexplained.
    @Parameter(
        title: "Link",
        description: "A YouTube link, or text with one in it.",
        requestValueDialog: "Which link?"
    )
    var link: String?

    init() {}

    init(link: String?) {
        self.link = link
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let supplied: String
        if let link, !link.isEmpty {
            supplied = link
        } else {
            supplied = try await $link.requestValue("Which link?")
        }

        let result = await AddToEddy.run(
            link: supplied,
            userId: KeychainIdentityStore().load(),
            config: try? AppConfig.load(from: .main)
        )
        switch result {
        case .success(let message):
            return .result(dialog: IntentDialog(stringLiteral: message))
        case .failure(let failure):
            throw EddyIntentError(failure)
        }
    }
}

/// What the intent does, with nothing of AppIntents in it — so every branch is
/// testable and the Shortcuts route can't drift from the share sheet.
enum AddToEddy {
    static func run(
        link: String,
        userId: String?,
        config: AppConfig?,
        transport: any HTTPTransport = URLSession.shared
    ) async -> Result<String, ShareFailure> {
        // Shortcuts will happily hand over a note, a filename or an empty
        // string. Only the "there is no link here at all" case is ours; what
        // counts as a link Eddy can fetch stays the server's call.
        guard ShareInput.containsWebLink(link) else {
            return .failure(.nothingShareable)
        }
        return await ShareSubmission.send(
            sharedText: link,
            userId: userId,
            config: config,
            transport: transport
        )
    }
}

/// Shortcuts shows an intent's thrown error verbatim, so the failure copy is
/// the same text the share card would have shown.
struct EddyIntentError: Error, CustomLocalizedStringResourceConvertible {
    let failure: ShareFailure

    init(_ failure: ShareFailure) {
        self.failure = failure
    }

    var localizedStringResource: LocalizedStringResource {
        LocalizedStringResource(stringLiteral: failure.line)
    }
}

/// Puts "Add to Eddy" in Shortcuts and Spotlight without anyone building a
/// shortcut first.
struct EddyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddToEddyIntent(),
            phrases: [
                "Add to \(.applicationName)",
                "Send this to \(.applicationName)",
            ],
            shortTitle: "Add to Eddy",
            systemImageName: "plus.circle"
        )
    }
}
