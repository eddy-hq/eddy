import Foundation
import Security

enum IdentityStoreError: Error, Equatable {
    case invalidUserId
    case invalidCredential
    case keychain(OSStatus)
}

/// Who this device is, as the server enrolled it (ADR-0016): the user it acts
/// for and the credential that proves it. The credential is what the server
/// believes; the userId is kept because the PWA still reads it from the URL.
struct DeviceIdentity: Equatable, Sendable {
    let userId: String
    let credential: String

    /// 32 random bytes, base64url, as the server mints them.
    static func isCredential(_ raw: String) -> Bool {
        raw.count == 43 && raw.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// Normalised, or nil if either half is malformed.
    static func make(userId: String, credential: String) -> DeviceIdentity? {
        guard let userId = UUIDValidator.normalise(userId), isCredential(credential) else { return nil }
        return DeviceIdentity(userId: userId, credential: credential)
    }
}

/// The shell's whole notion of "who is using this device". MainActor-isolated
/// because the only caller is the UI, which keeps it Sendable-clean without
/// any locking.
@MainActor
protocol IdentityStore: AnyObject {
    func load() -> DeviceIdentity?
    func save(_ identity: DeviceIdentity) throws
    func clear() throws
}

@MainActor
final class KeychainIdentityStore: IdentityStore {
    /// Hard-coded rather than derived from `Bundle.main.bundleIdentifier`:
    /// inside an app extension that bundle is the extension's own, so the
    /// share and notification extensions would look under a different service
    /// and find nothing.
    /// `nonisolated` so the notification service extension can name them
    /// without a hop to an actor it has no business touching.
    nonisolated static let defaultService = "app.eddyhq.Eddy.identity"

    /// Two items under one service. An install from before enrolment has only
    /// the first, which on its own no longer identifies anyone: `load()`
    /// answers nil and the shell asks for a setup link.
    private nonisolated static let userIdAccount = "userId"
    private nonisolated static let credentialAccount = "credential"

    private let service: String
    private let accessGroup: String?

    /// `accessGroup` nil means the target's default group. The app and the
    /// share extension both pass the shared group so the extension can read
    /// the identity the app stored — see `KeychainAccessGroup`.
    init(
        service: String = KeychainIdentityStore.defaultService,
        accessGroup: String? = KeychainAccessGroup.resolve()
    ) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private nonisolated static func baseQuery(
        service: String,
        account: String,
        accessGroup: String?
    ) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    func load() -> DeviceIdentity? {
        Self.readIdentity(service: service, accessGroup: accessGroup)
    }

    /// The read without the MainActor hop. The protocol is MainActor because
    /// the app's only caller is the UI, but the notification service extension
    /// is handed its request off the main thread and has no UI to hop to —
    /// and `SecItemCopyMatching` is thread-safe.
    nonisolated static func readIdentity(
        service: String = KeychainIdentityStore.defaultService,
        accessGroup: String? = KeychainAccessGroup.resolve()
    ) -> DeviceIdentity? {
        guard let userId = read(account: userIdAccount, service: service, accessGroup: accessGroup),
              let credential = read(account: credentialAccount, service: service, accessGroup: accessGroup)
        else { return nil }
        return DeviceIdentity.make(userId: userId, credential: credential)
    }

    private nonisolated static func read(account: String, service: String, accessGroup: String?) -> String? {
        var query = baseQuery(service: service, account: account, accessGroup: accessGroup)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func save(_ identity: DeviceIdentity) throws {
        guard let normalised = UUIDValidator.normalise(identity.userId) else {
            throw IdentityStoreError.invalidUserId
        }
        guard DeviceIdentity.isCredential(identity.credential) else {
            throw IdentityStoreError.invalidCredential
        }
        // Credential first: a save interrupted between the two leaves the old
        // userId beside the new credential. The server believes only the
        // credential, and the PWA corrects its URL from `GET /devices/me`.
        try write(identity.credential, account: Self.credentialAccount)
        try write(normalised, account: Self.userIdAccount)
    }

    private func write(_ value: String, account: String) throws {
        guard let data = value.data(using: .utf8) else { throw IdentityStoreError.invalidCredential }
        let query = Self.baseQuery(service: service, account: account, accessGroup: accessGroup)

        // AfterFirstUnlock, not WhenUnlocked: the notification service
        // extension has to read this while the device is locked. ThisDeviceOnly
        // because the credential is the whole proof of who this device is — it
        // has no business in a backup or on a restored replacement device.
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw IdentityStoreError.keychain(updated) }

        var insert = query
        insert.merge(attributes) { _, new in new }
        let added = SecItemAdd(insert as CFDictionary, nil)
        guard added == errSecSuccess else { throw IdentityStoreError.keychain(added) }
    }

    func clear() throws {
        for account in [Self.userIdAccount, Self.credentialAccount] {
            let query = Self.baseQuery(service: service, account: account, accessGroup: accessGroup)
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw IdentityStoreError.keychain(status)
            }
        }
    }
}

/// Tests and previews.
@MainActor
final class InMemoryIdentityStore: IdentityStore {
    private var identity: DeviceIdentity?

    init(seed: DeviceIdentity? = nil) {
        identity = seed.flatMap { DeviceIdentity.make(userId: $0.userId, credential: $0.credential) }
    }

    func load() -> DeviceIdentity? { identity }

    func save(_ newValue: DeviceIdentity) throws {
        guard UUIDValidator.normalise(newValue.userId) != nil else { throw IdentityStoreError.invalidUserId }
        guard let normalised = DeviceIdentity.make(userId: newValue.userId, credential: newValue.credential) else {
            throw IdentityStoreError.invalidCredential
        }
        identity = normalised
    }

    func clear() throws { identity = nil }
}
