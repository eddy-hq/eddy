import SwiftUI

/// The Tailscale-is-off screen. Shown only for a network-class failure — an
/// HTTP error page served by Eddy itself belongs to the PWA.
///
/// There is deliberately no "Open Tailscale" button: Tailscale publishes no
/// documented iOS URL scheme, and guessing one produces a button that silently
/// does nothing. If a scheme is ever confirmed from Tailscale's own docs, it
/// goes here.
struct UnreachableView: View {
    let reason: UnreachableReason
    let onRetry: () -> Void
    /// Reachable from here too: the hidden gesture lives on the web view, which
    /// isn't on screen when this is.
    let onReset: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Image(systemName: "wifi.slash")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Color.eddyTextSecondary)
                .padding(.bottom, 20)

            Text("Can't reach Eddy")
                .font(.system(.title2, design: .serif).weight(.semibold))
                .foregroundStyle(Color.eddyText)

            Text(detail)
                .font(.callout)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .foregroundStyle(Color.eddyTextSecondary)
                .padding(.top, 10)
                .padding(.horizontal, 36)

            Button(action: onRetry) {
                Text("Try again")
                    .font(.callout.weight(.medium))
                    .frame(maxWidth: 220)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .tint(Color.eddyAccent)
            .padding(.top, 28)

            Spacer()

            Button("Use a different link", action: onReset)
                .font(.footnote)
                .foregroundStyle(Color.eddyTextSecondary)
                .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var detail: String {
        switch reason {
        case .timeout:
            "Eddy took too long to answer. Check Tailscale is connected, then try again."
        case .network:
            "Eddy only answers over your home network. Open Tailscale, make sure it's connected, then try again."
        }
    }
}

#Preview {
    ZStack {
        Color.eddyBackground.ignoresSafeArea()
        UnreachableView(reason: .network, onRetry: {}, onReset: {})
    }
}
