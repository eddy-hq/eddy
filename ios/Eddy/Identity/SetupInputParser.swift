import Foundation

/// First launch has no identity. Rather than invent a sign-in, the shell asks
/// for the link the household already uses — the one with `?userId=` on it —
/// and pulls the id out of whatever gets pasted.
enum SetupInputParser {
    static func parse(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let bare = UUIDValidator.normalise(trimmed) { return bare }

        // A pasted link, an `eddy://setup?userId=` deep link, or a line of text
        // with one of those buried in it. `user=` is accepted because the PWA
        // treats it as an alias (see BottomNav.tsx).
        let embedded = /\buser(?:id)?=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/
            .ignoresCase()
        guard let match = trimmed.firstMatch(of: embedded) else { return nil }
        return UUIDValidator.normalise(String(match.output.1))
    }
}
