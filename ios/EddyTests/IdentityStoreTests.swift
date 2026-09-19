import XCTest
@testable import Eddy

@MainActor
final class IdentityStoreTests: XCTestCase {
    private let userId = "018f3a7c-1b2c-7d3e-8f40-51627384950a"

    func testStartsEmpty() {
        XCTAssertNil(InMemoryIdentityStore().load())
    }

    func testRoundTripsAndClears() throws {
        let store = InMemoryIdentityStore()
        try store.save(userId)
        XCTAssertEqual(store.load(), userId)
        try store.clear()
        XCTAssertNil(store.load())
    }

    func testNormalisesOnSave() throws {
        let store = InMemoryIdentityStore()
        try store.save("  \(userId.uppercased())  ")
        XCTAssertEqual(store.load(), userId)
    }

    func testRefusesAnythingThatIsNotAUUID() {
        let store = InMemoryIdentityStore()
        XCTAssertThrowsError(try store.save("not-a-uuid")) { error in
            XCTAssertEqual(error as? IdentityStoreError, .invalidUserId)
        }
        XCTAssertNil(store.load())
    }

    func testSeedIsValidated() {
        XCTAssertEqual(InMemoryIdentityStore(seed: userId).load(), userId)
        XCTAssertNil(InMemoryIdentityStore(seed: "nope").load())
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
            try store.save(userId)
            XCTAssertEqual(store.load(), userId)
            // Saving again is an update, not a duplicate insert.
            try store.save("018f3a7c-1b2c-7d3e-8f40-51627384950b")
            XCTAssertEqual(store.load(), "018f3a7c-1b2c-7d3e-8f40-51627384950b")
            try store.clear()
            XCTAssertNil(store.load())
        } catch IdentityStoreError.keychain(let status) {
            throw XCTSkip("Keychain unavailable to the test host (OSStatus \(status))")
        }
    }
}
