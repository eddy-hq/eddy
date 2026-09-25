import Foundation

/// Which APNs environment this build's token belongs to. Sent on registration
/// so the server pushes to the right Apple host — a token minted in one is
/// meaningless in the other.
enum PushEnvironment: String, Equatable, Sendable {
    case sandbox
    case production

    /// Derived from the embedded provisioning profile rather than a `#if DEBUG`,
    /// which would be wrong here: `scripts/release-adhoc.sh` archives the
    /// *Release* configuration with a development signing identity and only
    /// re-signs for distribution at export. A compile flag can't see that, and
    /// the profile can — its `aps-environment` entitlement is exactly what the
    /// token was issued against.
    static func current(bundle: Bundle = .main) -> PushEnvironment {
        guard let url = bundle.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url)
        else {
            // No embedded profile means the simulator, which cannot receive
            // APNs at all. Production is the safer guess of the two: an ad hoc
            // build is the only one the household installs.
            Log.push.notice("No embedded provisioning profile; assuming production")
            return .production
        }
        return environment(inProfile: data)
    }

    /// A `.mobileprovision` is a CMS envelope with a plain XML plist inside it.
    /// Rather than decode the signature, find the plist and read the one key
    /// that matters — the same thing Apple's own tooling does to display it.
    static func environment(inProfile data: Data) -> PushEnvironment {
        guard let value = apsEnvironment(inProfile: data) else {
            Log.push.notice("Provisioning profile has no aps-environment; assuming production")
            return .production
        }
        // Apple spells the development value "development"; the token it mints
        // is a sandbox token.
        return value == "development" ? .sandbox : .production
    }

    /// The raw entitlement value, or nil if the profile can't be read.
    static func apsEnvironment(inProfile data: Data) -> String? {
        guard let opening = data.range(of: Data("<plist".utf8)),
              let closing = data.range(of: Data("</plist>".utf8), in: opening.upperBound..<data.endIndex)
        else { return nil }

        // Re-wrapped rather than passed as a slice: a slice keeps the parent's
        // indices, and the parser wants a buffer that starts at zero.
        let plist = Data(data[opening.lowerBound..<closing.upperBound])
        guard let parsed = try? PropertyListSerialization.propertyList(
            from: plist,
            options: [],
            format: nil
        ) as? [String: Any] else { return nil }

        let entitlements = parsed["Entitlements"] as? [String: Any]
        return entitlements?["aps-environment"] as? String
    }
}
