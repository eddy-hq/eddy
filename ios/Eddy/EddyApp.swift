import SwiftUI

@main
struct EddyApp: App {
    @State private var model: ShellModel

    init() {
        let config: AppConfig
        do {
            config = try Self.debugBaseURLOverride() ?? AppConfig.load(from: .main)
        } catch {
            // A build-time misconfiguration (missing or malformed
            // EDDY_BASE_URL). Nothing in the app can work, so fail loudly
            // rather than ship a shell pointing nowhere.
            fatalError("EddyBaseURL is not usable: \(error)")
        }

        let store = Self.makeIdentityStore()
        _model = State(
            initialValue: ShellModel(
                config: config,
                identity: store,
                verifier: HTTPIdentityVerifier()
            )
        )
    }

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
        }
    }

    /// `-eddyBaseURL <url>` points a DEBUG build at another host, which is the
    /// only honest way to show the unreachable screen without unplugging the
    /// tailnet. Never compiled into a shipping build.
    private static func debugBaseURLOverride() throws -> AppConfig? {
        #if DEBUG
        guard let raw = UserDefaults.standard.string(forKey: "eddyBaseURL"), !raw.isEmpty else {
            return nil
        }
        var info = Bundle.main.infoDictionary ?? [:]
        info["EddyBaseURL"] = raw
        return try AppConfig.load(from: info)
        #else
        return nil
        #endif
    }

    @MainActor
    private static func makeIdentityStore() -> any IdentityStore {
        let store = KeychainIdentityStore()
        #if DEBUG
        // `-eddyUserId <uuid>` drives the app in the simulator without the
        // setup screen. It writes through to the shared keychain rather than
        // an in-memory store: the share extension is a separate process and
        // can only see what is really there.
        if let seeded = UserDefaults.standard.string(forKey: "eddyUserId"),
           let userId = UUIDValidator.normalise(seeded) {
            do {
                try store.save(userId)
            } catch {
                Log.identity.error("Couldn't seed the debug identity: \(String(describing: error), privacy: .public)")
                return InMemoryIdentityStore(seed: userId)
            }
        }
        #endif
        return store
    }
}
