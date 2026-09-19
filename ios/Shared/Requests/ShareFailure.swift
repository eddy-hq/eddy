import Foundation

/// Everything that can go wrong between tapping Eddy in the share sheet and
/// the request landing, in the words the person sees. Shared with the App
/// Intent so Shortcuts and the share card can't drift apart.
/// `Error` so it can be a `Result`'s failure type; it is never thrown as-is —
/// the App Intent wraps it so Shortcuts renders the copy rather than a type
/// name.
enum ShareFailure: Error, Equatable, Sendable {
    /// The server said no and said why. Its wording wins.
    case refused(String)
    case unreachable
    /// No identity on this device yet.
    case unpaired
    case nothingShareable
    case serverError

    var title: String {
        switch self {
        case .refused: "Eddy can't take that"
        case .unreachable: "Can't reach Eddy"
        case .unpaired: "This device isn't connected"
        case .nothingShareable: "Nothing to send"
        case .serverError: "Eddy had a problem"
        }
    }

    var detail: String {
        switch self {
        case .refused(let message): message
        case .unreachable: "Check Tailscale is connected, then try again."
        case .unpaired: "Open Eddy and paste your link, then share again."
        case .nothingShareable: "There's no link in what you shared."
        case .serverError: "Nothing was sent. Try again in a minute."
        }
    }

    /// One line, for a Shortcuts dialog or a thrown intent error, where there
    /// is no room for a title and a body.
    var line: String {
        switch self {
        case .refused(let message): message
        default: "\(title). \(detail)"
        }
    }
}

extension RequestOutcome {
    /// nil when the request landed.
    var failure: ShareFailure? {
        switch self {
        case .accepted: nil
        case .refused(let message): .refused(message)
        case .unreachable: .unreachable
        case .serverError: .serverError
        }
    }
}
