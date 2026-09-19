import SwiftUI

/// The whole share extension UI: one small card over whatever the person was
/// looking at. No compose field — there is nothing to edit, and the point of
/// the extension is that they never leave the app they were in.
struct ShareCardView: View {
    let model: ShareCardModel

    var body: some View {
        ZStack {
            Color.black.opacity(0.28)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()
                card
                    .frame(maxWidth: 340)
                    .padding(.horizontal, 24)
                Spacer()
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.state)
    }

    @ViewBuilder
    private var card: some View {
        VStack(spacing: 0) {
            switch model.state {
            case .sending:
                ProgressView()
                    .tint(Color.eddyTextSecondary)
                    .padding(.bottom, 14)
                Text("Sending to Eddy…")
                    .font(.system(.body, design: .serif).weight(.semibold))
                    .foregroundStyle(Color.eddyText)
                // Sending has its own way out. Nothing else here can end the
                // card while it waits, and "Close" rather than "Cancel"
                // because a request already on the wire will still land.
                Button("Close") { model.close() }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.eddyTextSecondary)
                    .padding(.top, 16)

            case .sent(let message):
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 30, weight: .regular))
                    .foregroundStyle(Color.eddyAccent)
                    .padding(.bottom, 12)
                Text(message)
                    .font(.system(.body, design: .serif).weight(.semibold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.eddyText)

            case .failed(let failure):
                Image(systemName: icon(for: failure))
                    .font(.system(size: 28, weight: .light))
                    .foregroundStyle(Color.eddyTextSecondary)
                    .padding(.bottom, 12)
                Text(failure.title)
                    .font(.system(.body, design: .serif).weight(.semibold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.eddyText)
                Text(failure.detail)
                    .font(.footnote)
                    .lineSpacing(2)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.eddyTextSecondary)
                    .padding(.top, 6)
                Button("Close") { model.close() }
                    .font(.callout.weight(.medium))
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(Color.eddyAccent)
                    .padding(.top, 18)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 28)
        .frame(maxWidth: .infinity)
        .background(Color.eddySurface, in: .rect(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(Color.eddyBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.12), radius: 20, y: 6)
    }

    private func icon(for failure: ShareFailure) -> String {
        switch failure {
        case .unreachable: "wifi.slash"
        case .unpaired: "link.badge.plus"
        case .nothingShareable: "questionmark.circle"
        case .refused, .serverError: "exclamationmark.circle"
        }
    }
}

#Preview("Sent") {
    ShareCardView(model: ShareCardModel(config: nil, identity: InMemoryIdentityStore(), finish: {}))
}
