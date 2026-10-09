import XCTest
@testable import Eddy

@MainActor
final class IdentityStoreTests: XCTestCase {
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"
    private let credential = String(repeating: "c", count: 43)
    private var identity: DeviceIdentity { DeviceIdentity(userId: userId, credential: credential) }

    func testStartsEmpty() {
        XCTAssertNil(InMemoryIdentityStore().load())
    }

    func testRoundTripsAndClears() throws {
        let store = InMemoryIdentityStore()
        try store.save(identity)
        XCTAssertEqual(store.load(), identity)
        try store.clear()
        XCTAssertNil(store.load())
    }

    func testNormalisesTheUserIdOnSave() throws {
        let store = InMemoryIdentityStore()
        try store.save(DeviceIdentity(userId: "  \(userId.uppercased())  ", credential: credential))
        XCTAssertEqual(store.load(), identity)
    }

    func testRefusesAnythingThatIsNotAUUID() {
        let store = InMemoryIdentityStore()
        XCTAssertThrowsError(try store.save(DeviceIdentity(userId: "not-a-uuid", credential: credential))) { error in
            XCTAssertEqual(error as? IdentityStoreError, .invalidUserId)
        }
        XCTAssertNil(store.load())
    }

    func testRefusesAMalformedCredential() {
        let store = InMemoryIdentityStore()
        XCTAssertThrowsError(try store.save(DeviceIdentity(userId: userId, credential: "short"))) { error in
            XCTAssertEqual(error as? IdentityStoreError, .invalidCredential)
        }
        XCTAssertThrowsError(try store.save(DeviceIdentity(userId: userId, credential: String(repeating: "+", count: 43))))
        XCTAssertNil(store.load())
    }

    func testSeedIsValidated() {
        XCTAssertEqual(InMemoryIdentityStore(seed: identity).load(), identity)
        XCTAssertNil(InMemoryIdentityStore(seed: DeviceIdentity(userId: "nope", credential: credential)).load())
        XCTAssertNil(InMemoryIdentityStore(seed: DeviceIdentity(userId: userId, credential: "")).load())
    }

    func testClearingWhenEmptyIsFine() throws {
        try InMemoryIdentityStore().clear()
    }

    /// The real thing, against the simulator's keychain. Skipped rather than
    /// failed if the keychain isn't available to the test host, so this can't
    /// become a flaky gate on an otherwise pure suite.
    func testKeychainRoundTrip() throws {
        let store = KeychainIdentityStore(service: "app.eddyhq.Eddy.tests.\(UUID().uuidString)")
        do {
            try store.clear()
            XCTAssertNil(store.load())
            try store.save(identity)
            XCTAssertEqual(store.load(), identity)
            // Saving again is an update, not a duplicate insert.
            let next = DeviceIdentity(userId: "018f3a7c-1b2c-7d3e-8f40-51627384950b", credential: String(repeating: "d", count: 43))
            try store.save(next)
            XCTAssertEqual(store.load(), next)
            try store.clear()
            XCTAssertNil(store.load())
        } catch IdentityStoreError.keychain(let status) {
            throw XCTSkip("Keychain unavailable to the test host (OSStatus \(status))")
        }
    }
}
