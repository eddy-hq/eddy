import Foundation

enum UUIDValidator {
    /// Canonical lowercase form, or nil if it isn't a well-formed UUID.
    /// The version is deliberately not checked: Eddy mints v7, but an install
    /// that seeded a v4 user shouldn't be locked out of its own app.
    static func normalise(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 36, let uuid = UUID(uuidString: trimmed) else { return nil }
        return uuid.uuidString.lowercased()
    }
}
