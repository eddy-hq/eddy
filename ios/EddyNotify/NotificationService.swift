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
            deliver(nil, debugReason: "no message id")
            return
        }
        guard let config = try? AppConfig.load(from: .main) else {
            Log.push.error("No usable EddyBaseURL in the extension's Info.plist")
            deliver(nil, debugReason: "no base URL")
            return
        }
        guard let userId = KeychainIdentityStore.readIdentity() else {
            Log.push.notice("No identity on this device; delivering the placeholder")
            deliver(nil, debugReason: "no identity in keychain")
            return
        }

        let client = NotificationContentClient(baseURL: config.baseURL)
        let task = Task { [weak self] in
            let result = await client.result(messageId: messageId, userId: userId)
            guard let self else { return }
            switch result {
            case .success(let content): self.deliver(content)
            case .failure(let failure): self.deliver(nil, debugReason: failure.debugLabel)
            }
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
        deliver(nil, debugReason: "extension expired")
    }

    /// nil content means "deliver what Apple sent". Called more than once by
    /// design; only the first call reaches iOS.
    private func deliver(_ fetched: NotificationContent?, debugReason: String? = nil) {
        lock.lock()
        let handler = contentHandler
        let content = placeholder
        contentHandler = nil
        lock.unlock()

        guard let handler, let content else { return }
        #if DEBUG
        // A development build only: the extension's log can't be read off a
        // device without root, so the reason rides on the notification. A
        // shipping build delivers the placeholder untouched.
        if fetched == nil, let debugReason { content.subtitle = "debug: \(debugReason)" }
        #endif
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
