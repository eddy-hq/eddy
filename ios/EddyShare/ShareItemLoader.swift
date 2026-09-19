import Foundation
import UniformTypeIdentifiers

/// Turns what the share sheet handed the extension into plain values, so the
/// decision about what to send is made by pure code (`ShareInput`) rather than
/// by an `NSItemProvider` callback.
///
/// MainActor-isolated because `NSExtensionItem` and `NSItemProvider` aren't
/// Sendable: they arrive on the main actor from `extensionContext` and stay
/// there. Only the resulting value types cross a concurrency boundary.
@MainActor
enum ShareItemLoader {
    /// A provider that never calls back would leave the card spinning with no
    /// way out, so every load is bounded. Generous: a well-behaved provider
    /// answers in milliseconds.
    static let itemTimeout: Duration = .seconds(5)

    static func load(from extensionItems: [NSExtensionItem]) async -> [SharedItem] {
        var loaded: [SharedItem] = []

        for item in extensionItems {
            for provider in item.attachments ?? [] {
                var value: SharedItem?
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    value = await loadItem(provider, type: UTType.url.identifier)
                }
                // Fall through on an empty result, not just on a provider that
                // never advertised a URL: a provider can advertise `public.url`
                // and still fail the load, or vend a representation `convert`
                // doesn't recognise. The plain-text representation registered
                // on that same provider is what the YouTube app actually
                // carries, so it deserves the attempt either way.
                if value == nil, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    value = await loadItem(provider, type: UTType.plainText.identifier)
                }
                if let value {
                    loaded.append(value)
                }
            }

            // Some apps put the link only in the item's own content text, with
            // the attachment carrying the title.
            if let text = item.attributedContentText?.string, !text.isEmpty {
                loaded.append(.text(text))
            }
        }

        return loaded
    }

    private static func loadItem(_ provider: NSItemProvider, type: String) async -> SharedItem? {
        await withCheckedContinuation { (continuation: CheckedContinuation<SharedItem?, Never>) in
            let once = OnceResumed(continuation)
            let timeout = Task {
                try? await Task.sleep(for: itemTimeout)
                Log.requests.notice("Share item load timed out: \(type, privacy: .public)")
                once.resume(nil)
            }
            provider.loadItem(forTypeIdentifier: type, options: nil) { value, error in
                // The message is the provider's, never the shared link.
                if let message = error?.localizedDescription {
                    Log.requests.notice("Share item load failed: \(message, privacy: .public)")
                }
                timeout.cancel()
                once.resume(convert(value))
            }
        }
    }

    /// Lets the load callback and the timeout race for one continuation without
    /// either being able to resume it twice.
    private final class OnceResumed: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<SharedItem?, Never>?

        init(_ continuation: CheckedContinuation<SharedItem?, Never>) {
            self.continuation = continuation
        }

        func resume(_ value: SharedItem?) {
            lock.lock()
            let pending = continuation
            continuation = nil
            lock.unlock()
            pending?.resume(returning: value)
        }
    }

    /// Runs on whatever queue `loadItem` calls back on, and hands back only a
    /// value type — so nothing non-Sendable ever leaves the callback.
    private nonisolated static func convert(_ value: NSSecureCoding?) -> SharedItem? {
        switch value {
        case let url as URL:
            return .url(url)
        case let text as String:
            return text.isEmpty ? nil : .text(text)
        case let data as Data:
            guard let text = String(data: data, encoding: .utf8), !text.isEmpty else { return nil }
            return .text(text)
        default:
            return nil
        }
    }
}
