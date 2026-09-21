import Foundation
import UserNotifications

/// Turns an opaque push into the real notification.
///
/// What Apple carried is `{aps: {alert: "Something new in Eddy", …}, m: <uuid>}`
/// and nothing else (ADR-0004). This wakes on delivery, reads the household's
/// userId out of the shared keychain exactly as the share extension does, asks
/// the M4 over the tailnet what the message says, and rewrites the notification
/// in place.
///
/// Every failure — no id, no identity, no route to the M4, a 404, junk JSON,
/// iOS ending the extension — delivers the placeholder unchanged. There is no
/// error copy: a person seeing "Something new in Eddy" opens the app, which is
/// the right thing to do either way.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    /// Guards the handoff: the fetch and the expiry callback race, and the
    /// content handler may be called exactly once.
    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var placeholder: UNMutableNotificationContent?
    private var fetch: Task<Void, Never>?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        lock.lock()
        self.contentHandler = contentHandler
        placeholder = request.content.mutableCopy() as? UNMutableNotificationContent
        lock.unlock()

        guard let messageId = PushMessage.id(in: request.content.userInfo) else {
            Log.push.notice("Push carried no usable message id")
            deliver(nil)
            return
        }
        guard let config = try? AppConfig.load(from: .main) else {
            Log.push.error("No usable EddyBaseURL in the extension's Info.plist")
            deliver(nil)
            return
        }
        guard let userId = KeychainIdentityStore.readIdentity() else {
            Log.push.notice("No identity on this device; delivering the placeholder")
            deliver(nil)
            return
        }

        let client = NotificationContentClient(baseURL: config.baseURL)
        let task = Task { [weak self] in
            let content = await client.content(messageId: messageId, userId: userId)
            self?.deliver(content)
        }
        lock.lock()
        fetch = task
        lock.unlock()
    }

    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let task = fetch
        lock.unlock()
        task?.cancel()
        Log.push.notice("Service extension expired; delivering the placeholder")
        deliver(nil)
    }

    /// nil content means "deliver what Apple sent". Called more than once by
    /// design; only the first call reaches iOS.
    private func deliver(_ fetched: NotificationContent?) {
        lock.lock()
        let handler = contentHandler
        let content = placeholder
        contentHandler = nil
        lock.unlock()

        guard let handler, let content else { return }
        if let fetched {
            content.title = fetched.title
            content.body = fetched.body
            // Carried through to the app so a tap lands on the right screen.
            // Only the path — the tap handler decides whether it is one Eddy
            // is willing to open.
            if let actionUrl = fetched.actionUrl {
                var userInfo = content.userInfo
                userInfo[PushMessage.actionURLKey] = actionUrl
                content.userInfo = userInfo
            }
        }
        handler(content)
    }
}
