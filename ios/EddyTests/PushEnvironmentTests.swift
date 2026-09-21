import XCTest
@testable import Eddy

final class PushEnvironmentTests: XCTestCase {
    /// A `.mobileprovision` is a CMS envelope: binary signature, an XML plist
    /// in the middle, more binary after it. Only the middle is parsed.
    private func profile(apsEnvironment: String?) -> Data {
        let entitlements = apsEnvironment.map {
            """
            \t\t<key>aps-environment</key>
            \t\t<string>\($0)</string>
            """
        } ?? ""
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
        \t<key>Name</key>
        \t<string>Eddy</string>
        \t<key>Entitlements</key>
        \t<dict>
        \t\t<key>get-task-allow</key>
        \t\t<true/>
        \(entitlements)
        \t</dict>
        </dict>
        </plist>
        """
        var data = Data([0x30, 0x82, 0x0b, 0x00, 0x06, 0x09])
        data.append(Data(plist.utf8))
        data.append(Data([0x00, 0xa0, 0x82, 0x03, 0x7f]))
        return data
    }

    func testADevelopmentProfileMeansASandboxToken() {
        XCTAssertEqual(PushEnvironment.environment(inProfile: profile(apsEnvironment: "development")), .sandbox)
    }

    func testAProductionProfileMeansAProductionToken() {
        XCTAssertEqual(PushEnvironment.environment(inProfile: profile(apsEnvironment: "production")), .production)
    }

    func testReadsTheRawEntitlementOutOfTheEnvelope() {
        XCTAssertEqual(PushEnvironment.apsEnvironment(inProfile: profile(apsEnvironment: "production")), "production")
    }

    /// A profile without push, or one this can't read at all: production is the
    /// safer guess, since the ad hoc build is the one the household installs.
    func testAProfileWithoutPushFallsBackToProduction() {
        XCTAssertNil(PushEnvironment.apsEnvironment(inProfile: profile(apsEnvironment: nil)))
        XCTAssertEqual(PushEnvironment.environment(inProfile: profile(apsEnvironment: nil)), .production)
    }

    func testGarbageFallsBackToProduction() {
        XCTAssertNil(PushEnvironment.apsEnvironment(inProfile: Data([0x30, 0x82, 0x0b, 0x00])))
        XCTAssertEqual(PushEnvironment.environment(inProfile: Data()), .production)
    }

    /// The wire value the server validates against.
    func testWireValues() {
        XCTAssertEqual(PushEnvironment.sandbox.rawValue, "sandbox")
        XCTAssertEqual(PushEnvironment.production.rawValue, "production")
    }
}
