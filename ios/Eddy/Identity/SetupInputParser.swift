import Foundation

/// First launch has no identity. The shell asks for the setup link a parent
/// made on the M4 (`npm run devices -- invite`, ADR-0016) and pulls the invite
/// out of whatever gets pasted. A bare `?userId=` link no longer sets anything
/// up: a user id is a claim, and the server has stopped believing claims.
enum SetupInputParser {
    /// An ADR-0005 signed token: base64url payload, a dot, a 64-hex HMAC.
    static func isInvite(_ raw: String) -> Bool {
        raw.wholeMatch(of: /[A-Za-z0-9_-]+\.[0-9a-f]{64}/) != nil
    }

    static func parse(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if isInvite(trimmed) { return trimmed }

        // A pasted link, an `eddy://setup?invite=` deep link, or a line of
        // text with one of those buried in it.
        let embedded = /[?&]invite=([A-Za-z0-9_-]+\.[0-9a-f]{64})(?![0-9a-f])/
        guard let match = trimmed.firstMatch(of: embedded) else { return nil }
        return String(match.output.1)
    }
}
