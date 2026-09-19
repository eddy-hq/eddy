import XCTest
@testable import Eddy

final class KeychainAccessGroupTests: XCTestCase {
    func testReadsWhateverTheBuildResolved() {
        let group = KeychainAccessGroup.resolve(from: [
            KeychainAccessGroup.infoKey: "ABCDE12345.app.eddyhq.Eddy.shared",
        ])
        XCTAssertEqual(group, "ABCDE12345.app.eddyhq.Eddy.shared")
    }

    /// An unsigned simulator build leaves `AppIdentifierPrefix` empty, so the
    /// group arrives unprefixed. That is still a usable group there.
    func testAcceptsTheUnprefixedSimulatorForm() {
        XCTAssertEqual(
            KeychainAccessGroup.resolve(from: [KeychainAccessGroup.infoKey: "app.eddyhq.Eddy.shared"]),
            "app.eddyhq.Eddy.shared"
        )
    }

    /// Passing an unexpanded build variable to the keychain would fail with an
    /// OSStatus nobody could read, so it falls back to the default group.
    func testRefusesAnUnexpandedBuildVariable() {
        XCTAssertNil(KeychainAccessGroup.resolve(from: [
            KeychainAccessGroup.infoKey: "$(AppIdentifierPrefix)app.eddyhq.Eddy.shared",
        ]))
    }

    /// On a device the entitlement only ever grants the team-prefixed group.
    /// Asking for the bare one would fail every keychain call with
    /// errSecMissingEntitlement, which surfaces as a device that can never be
    /// paired — so it falls back to the entitlement's own group instead.
    func testADeviceBuildRefusesAGroupWithNoTeamPrefix() {
        XCTAssertNil(KeychainAccessGroup.resolve(
            from: [KeychainAccessGroup.infoKey: "app.eddyhq.Eddy.shared"],
            requiresTeamPrefix: true
        ))
        XCTAssertEqual(
            KeychainAccessGroup.resolve(
                from: [KeychainAccessGroup.infoKey: "ABCDE12345.app.eddyhq.Eddy.shared"],
                requiresTeamPrefix: true
            ),
            "ABCDE12345.app.eddyhq.Eddy.shared"
        )
    }

    func testTeamPrefixDetection() {
        XCTAssertTrue(KeychainAccessGroup.isTeamPrefixed("ABCDE12345.app.eddyhq.Eddy.shared"))
        XCTAssertFalse(KeychainAccessGroup.isTeamPrefixed("app.eddyhq.Eddy.shared"))
        XCTAssertFalse(KeychainAccessGroup.isTeamPrefixed("ABCDE12345.app.eddyhq.Other"))
    }

    func testMissingOrEmptyMeansTheDefaultGroup() {
        XCTAssertNil(KeychainAccessGroup.resolve(from: [:]))
        XCTAssertNil(KeychainAccessGroup.resolve(from: [KeychainAccessGroup.infoKey: "   "]))
        XCTAssertNil(KeychainAccessGroup.resolve(from: [KeychainAccessGroup.infoKey: 7]))
    }

    /// The app's own build must resolve one, or the share extension will look
    /// somewhere else and find nothing.
    func testTheHostAppBundleResolvesAGroup() throws {
        guard Bundle.main.infoDictionary?["EddyBaseURL"] != nil else {
            throw XCTSkip("Not running inside the app bundle")
        }
        let group = try XCTUnwrap(
            KeychainAccessGroup.resolve(from: .main),
            "The app bundle has no EddyKeychainAccessGroup"
        )
        XCTAssertTrue(group.hasSuffix("app.eddyhq.Eddy.shared"))
    }

    /// Whether the shared group is actually usable here. Skipped rather than
    /// failed when it isn't: an unsigned simulator build has no real
    /// entitlement, and that must not gate an otherwise pure suite.
    @MainActor
    func testTheSharedGroupIsWritableFromTheApp() throws {
        guard let group = KeychainAccessGroup.resolve(from: .main) else {
            throw XCTSkip("No access group resolved in this build")
        }
        let store = KeychainIdentityStore(
            service: "app.eddyhq.Eddy.tests.\(UUID().uuidString)",
            accessGroup: group
        )
        let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"
        do {
            try store.save(userId)
            XCTAssertEqual(store.load(), userId)
            try store.clear()
        } catch IdentityStoreError.keychain(let status) {
            throw XCTSkip("Shared keychain group unusable here (OSStatus \(status))")
        }
    }
}
