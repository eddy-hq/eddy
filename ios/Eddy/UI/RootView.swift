import SwiftUI

struct RootView: View {
    @Bindable var model: ShellModel

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color.eddyBackground.ignoresSafeArea()

            switch model.state {
            case .setup:
                SetupView(model: model)
            case .loading, .loaded:
                WebHostView(model: model)
            case .unreachable(let reason):
                UnreachableView(reason: reason, onRetry: model.retry, onReset: model.requestIdentityReset)
            }
        }
        .onOpenURL { model.handle($0) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.enteredForeground() }
        }
        .task { model.start() }
        .alert("Disconnect this device?", isPresented: $model.isConfirmingReset) {
            Button("Cancel", role: .cancel) {}
            Button("Disconnect", role: .destructive) { model.clearIdentity() }
        } message: {
            Text("Eddy will ask for your link again next time.")
        }
    }
}
