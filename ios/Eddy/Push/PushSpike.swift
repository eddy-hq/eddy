import SwiftUI
import UIKit
import UserNotifications

/// SPIKE: registers for remote notifications and surfaces the APNs device
/// token so a push can be sent by hand from the M4 (scripts/spike-send-push.mjs).
/// Stage 4 replaces this with `POST /devices`; none of it is meant to ship.
@MainActor
@Observable
final class PushSpike {
    static let shared = PushSpike()

    var token: String?
    var failure: String?
    var isShowing = false

    func register() {
        Task {
            let centre = UNUserNotificationCenter.current()
            let granted = (try? await centre.requestAuthorization(options: [.alert, .sound])) ?? false
            guard granted else {
                failure = "Notifications were not allowed."
                isShowing = true
                return
            }
            UIApplication.shared.registerForRemoteNotifications()
        }
    }
}

final class PushSpikeAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        PushSpike.shared.register()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        PushSpike.shared.token = hex
        PushSpike.shared.isShowing = true
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        PushSpike.shared.failure = error.localizedDescription
        PushSpike.shared.isShowing = true
    }
}

struct PushSpikeAlert: ViewModifier {
    @Bindable var spike = PushSpike.shared

    func body(content: Content) -> some View {
        content.alert("APNs spike", isPresented: $spike.isShowing) {
            if let token = spike.token {
                Button("Copy token") { UIPasteboard.general.string = token }
            }
            Button("Close", role: .cancel) {}
        } message: {
            Text(spike.token.map { "Device token ready (\($0.count) characters)." } ?? spike.failure ?? "No token.")
        }
    }
}
