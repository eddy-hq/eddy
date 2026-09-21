import UIKit
import UserNotifications

/// The only reason the shell has an app delegate: APNs hands the device token
/// and notification taps to one, and SwiftUI has no equivalent.
@MainActor
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    private var controller: PushController?
    private weak var model: ShellModel?

    /// Called once the SwiftUI side has a model. The delegate is created by
    /// `@UIApplicationDelegateAdaptor` with no arguments, so the wiring has to
    /// come the other way.
    func attach(to model: ShellModel) {
        guard controller == nil else { return }
        self.model = model
        UNUserNotificationCenter.current().delegate = self

        let controller = PushController(config: model.config)
        self.controller = controller
        model.push = controller
        // Registration waits for an identity: asking for notifications while
        // the setup screen is up would prompt someone who hasn't yet said what
        // Eddy is.
        if let userId = model.userId { controller.identityAvailable(userId) }
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        controller?.received(token: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
        controller?.registrationFailed(error)
    }
}

extension PushAppDelegate: UNUserNotificationCenterDelegate {
    /// Without this a push that arrives while Eddy is on screen is delivered
    /// to the app and shown to nobody — the spike watched it happen.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        // `userInfo` is not Sendable, so the link is decided here and only the
        // URL crosses to the main actor. No link means the extension never
        // learned where to go: opening the app is the whole action.
        let link = NotificationTapRouter.deepLink(in: response.notification.request.content.userInfo)
        guard let link else { return }
        await MainActor.run { [weak self] in
            self?.model?.handle(link)
        }
    }
}
