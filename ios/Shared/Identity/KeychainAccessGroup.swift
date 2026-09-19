import Foundation

/// The keychain access group the app and its extensions share.
///
/// The real string is team-prefixed (`ABCDE12345.app.eddyhq.Eddy.shared`) and
/// the prefix is only known at build time, so it is never written down here.
/// Each target's Info.plist carries `$(AppIdentifierPrefix)app.eddyhq.Eddy.shared`
/// alongside the matching `keychain-access-groups` entitlement, and this reads
/// back whatever the build resolved it to.
enum KeychainAccessGroup {
    static let infoKey = "EddyKeychainAccessGroup"

    /// The group without its team prefix — the same string both entitlements
    /// carry. Not a secret: it is the app's own identifier, in two committed
    /// plists already.
    static let unprefixedGroup = "app.eddyhq.Eddy.shared"

    /// On a device the entitlement is only ever granted with the team prefix,
    /// so a bare group there means the two plists disagree.
    #if targetEnvironment(simulator)
    static let teamPrefixRequired = false
    #else
    static let teamPrefixRequired = true
    #endif

    /// nil means "don't pass `kSecAttrAccessGroup` at all", which lands items
    /// in the target's *first entitlement* group — the shared one, since that
    /// is the only entry either target lists — and in the target's default
    /// group on a build with no entitlement at all.
    static func resolve(
        from info: [String: Any],
        requiresTeamPrefix: Bool = KeychainAccessGroup.teamPrefixRequired
    ) -> String? {
        guard let raw = info[infoKey] as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        // An unexpanded `$(...)` means the build setting wasn't defined; using
        // it verbatim would make every keychain call fail with a puzzling
        // OSStatus instead of quietly falling back.
        guard !trimmed.contains("$(") else { return nil }
        // An unsigned simulator build leaves `AppIdentifierPrefix` empty, so
        // the group arrives without its leading `TEAMID.`. The simulator
        // keychain doesn't enforce groups, so the bare form is harmless there.
        // On a device it is not: the entitlement grants the prefixed group, so
        // asking for the bare one fails every SecItem call with
        // errSecMissingEntitlement — which `load()` can only report as "no
        // identity", leaving the app stuck on setup forever. Falling back to
        // the entitlement's own first group keeps it working, and the log says
        // which build setting didn't arrive.
        if requiresTeamPrefix, !isTeamPrefixed(trimmed) {
            Log.identity.error("\(infoKey, privacy: .public) has no team prefix — using the entitlement's group")
            return nil
        }
        return trimmed
    }

    static func isTeamPrefixed(_ group: String) -> Bool {
        group.hasSuffix(unprefixedGroup) && group.count > unprefixedGroup.count
    }

    static func resolve(from bundle: Bundle = .main) -> String? {
        resolve(from: bundle.infoDictionary ?? [:])
    }
}
