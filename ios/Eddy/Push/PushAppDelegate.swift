import UIKit
import UserNotifications

/// The only reason the shell has an app delegate: APNs hands the device token
/// and notification taps to one, and SwiftUI has no equivalent.
@MainActor
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    private var controller: PushController?
    private weak var model: ShellModel?
    /// A tap that woke the app arrives before the SwiftUI side has handed over
    /// a model, so the link waits here rather than being dropped.
    private var pendingLink: URL?

    /// The notification delegate has to be in place before launching finishes:
    /// a tap that launched the app is delivered in that window, and a delegate
    /// set later never hears about it.
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// Called once the SwiftUI side has a model. The delegate is created by
    /// `@UIApplicationDelegateAdaptor` with no arguments, so the wiring has to
    /// come the other way.
    func attach(to model: ShellModel) {
        guard controller == nil else { return }
        bind(model)

        let controller = PushController(config: model.config)
        self.controller = controller
        model.push = controller
        // Registration waits for an identity: asking for notifications while
        // the setup screen is up would prompt someone who hasn't yet said what
        // Eddy is.
        if let userId = model.userId { controller.identityAvailable(userId) }
    }

    /// Model wiring on its own, so the launch-time tap path can be exercised
    /// without APNs. Anything a tap asked for while the model was missing is
    /// replayed here — `start()` won't overwrite a load already asked for.
    func bind(_ model: ShellModel) {
        self.model = model
        guard let link = pendingLink else { return }
        pendingLink = nil
        model.handle(link)
    }

    /// nil means the notification had nowhere to go — either the server sent no
    /// action, or the extension's fetch failed and never learned where. Opening
    /// the app is then the whole action.
    func follow(_ link: URL?) {
        guard let link else { return }
        guard let model else {
            pendingLink = link
            return
        }
        model.handle(link)
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
        // URL crosses to the main actor.
        let link = NotificationTapRouter.deepLink(in: response.notification.request.content.userInfo)
        await MainActor.run { [weak self] in
            self?.follow(link)
        }
    }
}
