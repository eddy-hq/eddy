import Foundation

/// What the app last told the server about itself. The registration runs at
/// launch and on every foreground, and almost every one of those is a repeat:
/// the ledger is what makes the repeat free.
///
/// Only a *successful* registration is recorded, so a failed one is retried on
/// the next foreground rather than remembered as done.
struct PushRegistrationLedger: Equatable, Sendable {
    private struct Sent: Equatable, Sendable {
        let userId: String
        let token: String
    }

    /// The id the server gave this device, kept so a re-registration updates
    /// the same row. It belongs to one identity: the server answers 404 for a
    /// device id owned by somebody else, so it is dropped with the identity.
    private(set) var deviceId: String?
    private var sent: Sent?

    init(deviceId: String? = nil) {
        self.deviceId = deviceId
    }

    func needsRegistration(userId: String, token: String) -> Bool {
        sent != Sent(userId: userId, token: token)
    }

    mutating func recordRegistration(userId: String, token: String, deviceId: String) {
        sent = Sent(userId: userId, token: token)
        self.deviceId = deviceId
    }

    /// The identity went away, or was replaced. Nothing is registered now.
    mutating func forget() {
        sent = nil
        deviceId = nil
    }
}
