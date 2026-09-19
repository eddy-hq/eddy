import SwiftUI

/// The handful of tokens from `src/pwa/index.css` the native screens need, so
/// setup and the fallback screen sit in the same palette as the web app.
extension Color {
    /// `--bg-primary`. The launch screen uses the matching `LaunchBackground`
    /// colour set, so there's no white flash between launch, native chrome and
    /// the web view.
    static let eddyBackground = Color(red: 250 / 255, green: 250 / 255, blue: 248 / 255)
    /// `--bg-surface`.
    static let eddySurface = Color(red: 1, green: 1, blue: 1)
    /// `--text-primary`.
    static let eddyText = Color(red: 26 / 255, green: 25 / 255, blue: 22 / 255)
    /// `--text-secondary`.
    static let eddyTextSecondary = Color(red: 107 / 255, green: 104 / 255, blue: 96 / 255)
    /// `--accent`.
    static let eddyAccent = Color(red: 61 / 255, green: 107 / 255, blue: 107 / 255)
    /// `--dismiss`, used here only for error text.
    static let eddyDismiss = Color(red: 184 / 255, green: 84 / 255, blue: 80 / 255)
    /// `--border-subtle`.
    static let eddyBorder = Color(red: 26 / 255, green: 25 / 255, blue: 22 / 255).opacity(0.08)
}
