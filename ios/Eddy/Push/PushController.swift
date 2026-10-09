import UIKit
import UserNotifications

/// What `ShellModel` is allowed to ask of push. Deliberately three calls: the
/// shell reports what happened to the identity and when it came back to the
/// foreground, and knows nothing about APNs.
@MainActor
protocol PushRegistering: AnyObject {
    func identityAvailable(_ identity: DeviceIdentity)
    func identityWillClear()
    func enteredForeground()
}

/// Registers this device for push and keeps `POST /devices` up to date.
///
/// Every path here logs and swallows. Push is an addition to the shell, not a
/// dependency of it: a refused authorisation, a dead tailnet or a server that
/// answers 500 must leave the app behaving exactly as it did before.
@MainActor
final class PushController: PushRegistering {
    /// The server's device id, kept across launches so a re-registration
    /// updates one row. Not a secret and not a person: a UUID the server minted.
    static let deviceIdKey = "EddyDeviceId"

    private let client: DeviceRegistrationClient
    private let environment: PushEnvironment
    private let deviceType: String
    private let defaults: UserDefaults

    private var identity: DeviceIdentity?
    private var userId: String? { identity?.userId }
    private var token: String?
    private var ledger: PushRegistrationLedger
    private var isRegistering = false

    init(config: AppConfig, defaults: UserDefaults = .standard) {
        client = DeviceRegistrationClient(baseURL: config.baseURL)
        environment = PushEnvironment.current()
        // The only thing the server is told about the hardware, and it is told
        // because a tablet and a phone are pushed to differently, not because
        // anyone wants an inventory.
        deviceType = UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone"
        self.defaults = defaults
        ledger = PushRegistrationLedger(deviceId: defaults.string(forKey: Self.deviceIdKey))
    }

    // MARK: - Shell events

    func identityAvailable(_ identity: DeviceIdentity) {
        guard self.identity != identity else {
            // Same device, called again on a later launch: nothing to ask for,
            // but the token may have rotated since.
            refreshTokenIfAuthorised()
            return
        }
        // A new enrolment is a new device row.
        if self.identity != nil { ledger.forget() }
        self.identity = identity
        askForAuthorisation()
    }

    func identityWillClear() {
        let credential = identity?.credential
        identity = nil
        ledger.forget()
        defaults.removeObject(forKey: Self.deviceIdKey)

        guard let credential else { return }
        // Deleting the row revokes the credential (ADR-0016). Best effort, and
        // not awaited: the person has already tapped Disconnect and the shell
        // is not going to wait on the network for it.
        Task { [client] in
            await client.deregister(credential: credential)
        }
    }

    func enteredForeground() {
        guard userId != nil else { return }
        refreshTokenIfAuthorised()
        register()
    }

    // MARK: - APNs callbacks

    func received(token deviceToken: Data) {
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
        // The token is a credential. Its presence is the whole log line.
        Log.push.info("APNs token registered")
        register()
    }

    func registrationFailed(_ error: any Error) {
        Log.push.notice("APNs registration failed: \(error.localizedDescription, privacy: .public)")
    }

    // MARK: - Internals

    private func askForAuthorisation() {
        Task {
            let centre = UNUserNotificationCenter.current()
            let granted = (try? await centre.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            guard granted else {
                Log.push.notice("Notifications are not authorised on this device")
                return
            }
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Asking again is how a rotated token arrives: iOS answers from its cache
    /// when nothing has changed, and the ledger drops the repeat before it
    /// costs a request. Never prompts — a device that said no stays saying no
    /// until Settings says otherwise.
    private func refreshTokenIfAuthorised() {
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                UIApplication.shared.registerForRemoteNotifications()
            default:
                return
            }
        }
    }

    private func register() {
        guard let identity, let token, !isRegistering,
              ledger.needsRegistration(userId: identity.userId, token: token)
        else { return }

        let registration = DeviceRegistration(
            apnsToken: token,
            apnsEnvironment: environment.rawValue,
            deviceType: deviceType
        )
        isRegistering = true
        Task { [client] in
            let deviceId = await client.register(registration, credential: identity.credential)
            finish(registration, for: identity, deviceId: deviceId)
        }
    }

    private func finish(_ registration: DeviceRegistration, for registered: DeviceIdentity, deviceId: String?) {
        isRegistering = false
        switch PushRegistrationOutcome.resolve(
            currentCredential: identity?.credential,
            registeredCredential: registered.credential,
            deviceId: deviceId
        ) {
        case .record(let deviceId):
            ledger.recordRegistration(
                userId: registered.userId,
                token: registration.apnsToken,
                deviceId: deviceId
            )
            defaults.set(deviceId, forKey: Self.deviceIdKey)
            Log.push.info("Device registered for push (\(self.environment.rawValue, privacy: .public))")
        case .orphaned:
            // Disconnect (or a new enrolment) landed while the request was in
            // flight. The row belongs to a credential this side has let go of:
            // delete it, or the device keeps receiving pushes for someone who
            // has left. A no-op if Disconnect's own delete got there first.
            Task { [client] in
                await client.deregister(credential: registered.credential)
            }
        case .failed:
            // Logged by the client. Returning here is what stops a server
            // that is down from being retried in a tight loop; the next
            // foreground tries again.
            return
        }
        // A rotated token or a new identity that arrived while this request
        // was running was dropped by the isRegistering guard. The ledger makes
        // this a no-op when nothing has changed.
        register()
    }
}

/// What to do with a finished registration, given which credential the device
/// holds now. Compared by credential, not user: Disconnect and a fresh setup
/// for the same person is a new device row. Pure, so the in-flight races are
/// testable without UIKit.
enum PushRegistrationOutcome: Equatable {
    case record(deviceId: String)
    case orphaned(deviceId: String)
    case failed

    static func resolve(currentCredential: String?, registeredCredential: String, deviceId: String?) -> Self {
        guard let deviceId else { return .failed }
        return currentCredential == registeredCredential
            ? .record(deviceId: deviceId)
            : .orphaned(deviceId: deviceId)
    }
}
