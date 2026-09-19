import Foundation

/// The one sequence both share routes run: identity, config, POST, and the
/// single sentence a person ends up reading. The share card and the App Intent
/// differ only in how they show the result — if they each owned this, the two
/// routes would drift on what counts as unpaired or unreachable.
///
/// Pure apart from the network call it is handed: every input arrives as a
/// value, so all five branches are testable without a keychain or a server.
enum ShareSubmission {
    /// `userId` and `config` are optional because both can genuinely be
    /// absent — a device nobody has paired, or a build with an unusable
    /// `EddyBaseURL` — and each has its own thing to say.
    static func send(
        sharedText: String,
        userId: String?,
        config: AppConfig?,
        transport: any HTTPTransport = URLSession.shared
    ) async -> Result<String, ShareFailure> {
        guard let userId else { return .failure(.unpaired) }
        guard let config else {
            Log.requests.error("No usable EddyBaseURL")
            return .failure(.serverError)
        }

        let client = RequestClient(baseURL: config.baseURL, transport: transport)
        let outcome = await client.submit(sharedText: sharedText, userId: userId)
        guard case .accepted(let message, _) = outcome else {
            return .failure(outcome.failure ?? .serverError)
        }
        return .success(message)
    }
}
