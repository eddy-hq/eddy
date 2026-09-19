import SwiftUI

/// First launch. The shell has no sign-in of its own — it asks for the link
/// the household already uses and keeps the id out of it.
struct SetupView: View {
    let model: ShellModel

    @State private var input = ""
    @State private var message: String?
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Eddy")
                    .font(.system(size: 40, design: .serif).weight(.semibold))
                    .foregroundStyle(Color.eddyText)
                    .padding(.top, 56)

                Text("Paste your Eddy link to connect this device — the one with your id on the end. You only do this once.")
                    .font(.callout)
                    .lineSpacing(3)
                    .foregroundStyle(Color.eddyTextSecondary)
                    .padding(.top, 12)

                // `verbatim`: a bare URL in a LocalizedStringKey is parsed as
                // Markdown and comes out as a blue tappable link.
                TextField(
                    "",
                    text: $input,
                    prompt: Text(verbatim: "https://eddyhq.app/feed?userId=…"),
                    axis: .vertical
                )
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .submitLabel(.go)
                    .focused($focused)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Color.eddyText)
                    .lineLimit(1...4)
                    .padding(14)
                    .background(Color.eddySurface, in: .rect(cornerRadius: 12))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .strokeBorder(Color.eddyBorder, lineWidth: 1)
                    )
                    .padding(.top, 32)

                Text(message ?? " ")
                    .font(.footnote)
                    .foregroundStyle(message == nil ? .clear : Color.eddyDismiss)
                    .padding(.top, 10)

                Button {
                    focused = false
                    Task { await connect() }
                } label: {
                    Group {
                        if model.isVerifying {
                            ProgressView().tint(.white)
                        } else {
                            Text("Connect").font(.callout.weight(.medium))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(Color.eddyAccent)
                .disabled(input.isEmpty || model.isVerifying)
                .padding(.top, 8)

                Spacer(minLength: 24)
            }
            .padding(.horizontal, 28)
            .frame(maxWidth: 520, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func connect() async {
        message = nil
        switch await model.completeSetup(with: input) {
        case .ok:
            input = ""
        case .invalidInput:
            message = "That doesn't look like an Eddy link."
        case .unknownUser:
            message = "Eddy doesn't recognise that id."
        case .unreachable:
            message = "Couldn't reach Eddy. Check Tailscale is connected."
        case .failed(let detail):
            message = "Couldn't save that: \(detail)"
        }
    }
}
