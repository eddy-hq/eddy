import Foundation
import UserNotifications

/// SPIKE (brief §21, open question 4): can a Notification Service Extension
/// reach Eddy over the tailnet while the VPN app is backgrounded?
///
/// Every mutable push triggers one GET of `/health` and the outcome is written
/// into the notification itself, so the answer is readable from the lock
/// screen without a cable. No identity, no content, nothing about any user.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    /// iOS gives the extension roughly 30 s; stay well inside it so a slow
    /// tailnet reports as a failure we wrote rather than a silent expiry.
    private static let fetchTimeout: TimeInterval = 20

    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?
    private var task: URLSessionDataTask?
    private var startedAt = Date()

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        startedAt = Date()
        self.contentHandler = contentHandler
        content = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let raw = Bundle.main.object(forInfoDictionaryKey: "EddyBaseURL") as? String,
              let url = URL(string: raw)?.appendingPathComponent("health") else {
            finish("NSE: no EddyBaseURL in the extension's Info.plist")
            return
        }

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = Self.fetchTimeout
        config.timeoutIntervalForResource = Self.fetchTimeout
        config.waitsForConnectivity = false

        let task = URLSession(configuration: config).dataTask(with: url) { [weak self] _, response, error in
            guard let self else { return }
            let ms = Int(Date().timeIntervalSince(self.startedAt) * 1000)
            if let error = error as NSError? {
                self.finish("NSE fetch FAILED after \(ms) ms — \(error.domain) \(error.code)")
            } else if let http = response as? HTTPURLResponse {
                self.finish("NSE reached Eddy in \(ms) ms — HTTP \(http.statusCode)")
            } else {
                self.finish("NSE fetch returned no HTTP response after \(ms) ms")
            }
        }
        self.task = task
        task.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        task?.cancel()
        finish("NSE EXPIRED — iOS ended the extension before the fetch returned")
    }

    /// Delivers exactly once: the fetch callback and the expiry callback can race.
    private func finish(_ body: String) {
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        lock.unlock()
        guard let handler, let content else { return }
        content.body = body
        handler(content)
    }
}
