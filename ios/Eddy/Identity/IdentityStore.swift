import Foundation
import Security

enum IdentityStoreError: Error, Equatable {
    case invalidUserId
    case keychain(OSStatus)
}

/// The shell's whole notion of "who is using this device". MainActor-isolated
/// because the only caller is the UI, which keeps it Sendable-clean without
/// any locking.
@MainActor
protocol IdentityStore: AnyObject {
    func load() -> String?
    func save(_ userId: String) throws
    func clear() throws
}

@MainActor
final class KeychainIdentityStore: IdentityStore {
    /// Hard-coded rather than derived from `Bundle.main.bundleIdentifier`:
    /// inside an app extension that bundle is the extension's own, so the
    /// share and notification extensions would look under a different service
    /// and find nothing. (They will also need a keychain access group before
    /// they can read this at all — stage 2 work, not stage 1.)
    static let defaultService = "app.eddyhq.Eddy.identity"

    private let service: String
    private let account = "userId"

    init(service: String = KeychainIdentityStore.defaultService) {
        self.service = service
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let raw = String(data: data, encoding: .utf8)
        else { return nil }
        return UUIDValidator.normalise(raw)
    }

    func save(_ userId: String) throws {
        guard let normalised = UUIDValidator.normalise(userId),
              let data = normalised.data(using: .utf8)
        else { throw IdentityStoreError.invalidUserId }

        // AfterFirstUnlock, not WhenUnlocked: a later notification service
        // extension has to read this while the device is locked. ThisDeviceOnly
        // because the userId is the whole credential — it has no business in a
        // backup or on a restored replacement device.
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updated = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw IdentityStoreError.keychain(updated) }

        var insert = baseQuery
        insert.merge(attributes) { _, new in new }
        let added = SecItemAdd(insert as CFDictionary, nil)
        guard added == errSecSuccess else { throw IdentityStoreError.keychain(added) }
    }

    func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw IdentityStoreError.keychain(status)
        }
    }
}

/// Tests, previews, and the DEBUG `-eddyUserId` launch argument.
@MainActor
final class InMemoryIdentityStore: IdentityStore {
    private var userId: String?

    init(seed: String? = nil) {
        userId = seed.flatMap(UUIDValidator.normalise)
    }

    func load() -> String? { userId }

    func save(_ newValue: String) throws {
        guard let normalised = UUIDValidator.normalise(newValue) else {
            throw IdentityStoreError.invalidUserId
        }
        userId = normalised
    }

    func clear() throws { userId = nil }
}
