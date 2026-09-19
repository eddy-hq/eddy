import XCTest
@testable import Eddy

final class AppConfigTests: XCTestCase {
    func testLoadsBaseURLAndVersionFromInfoDictionary() throws {
        let config = try AppConfig.load(from: [
            "EddyBaseURL": "https://eddyhq.app",
            "CFBundleShortVersionString": "1.0",
            "CFBundleVersion": "7",
        ])
        XCTAssertEqual(config.baseURL.absoluteString, "https://eddyhq.app")
        XCTAssertEqual(config.origin, WebOrigin(url: URL(string: "https://eddyhq.app")!))
        XCTAssertEqual(config.version, "1.0 (7)")
    }

    func testAcceptsAnotherHouseholdsHostWithAPort() throws {
        let config = try AppConfig(baseURLString: "http://eddy.example.ts.net:8080", version: "1")
        XCTAssertEqual(config.origin.port, 8080)
        XCTAssertEqual(config.origin.host, "eddy.example.ts.net")
    }

    func testTrimsWhitespace() throws {
        let config = try AppConfig(baseURLString: "  https://eddyhq.app\n", version: "1")
        XCTAssertEqual(config.origin.host, "eddyhq.app")
    }

    func testRejectsMissingKey() {
        XCTAssertThrowsError(try AppConfig.load(from: [:])) { error in
            XCTAssertEqual(error as? AppConfig.ConfigError, .missingBaseURL)
        }
    }

    func testRejectsEmptyValue() {
        XCTAssertThrowsError(try AppConfig(baseURLString: "   ", version: "1")) { error in
            XCTAssertEqual(error as? AppConfig.ConfigError, .missingBaseURL)
        }
    }

    /// The xcconfig "//" trap: if EDDY_BASE_URL loses its separator the value
    /// arrives unresolved or hostless, and the app must not start on it.
    func testRejectsUnresolvedBuildSetting() {
        XCTAssertThrowsError(try AppConfig(baseURLString: "$(EDDY_BASE_URL)", version: "1"))
        XCTAssertThrowsError(try AppConfig(baseURLString: "https:eddyhq.app", version: "1"))
    }

    func testRejectsNonWebScheme() {
        XCTAssertThrowsError(try AppConfig(baseURLString: "ftp://eddyhq.app", version: "1")) { error in
            XCTAssertEqual(error as? AppConfig.ConfigError, .unsupportedScheme("ftp"))
        }
    }

    /// The shipping build's own Info.plist — the only place the xcconfig
    /// splicing is actually exercised. Unit tests are hosted by the app, so
    /// `Bundle.main` is the app bundle.
    func testShippingBundleResolvesToARealOrigin() throws {
        let config = try AppConfig.load(from: Bundle.main)
        XCTAssertEqual(config.origin.scheme, "https")
        XCTAssertFalse(config.origin.host.isEmpty)
        XCTAssertFalse(config.origin.host.contains("$"))
    }
}
