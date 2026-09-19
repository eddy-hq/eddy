import Foundation

/// Everything the shell needs to know about the Eddy install it fronts.
/// Sourced from Info.plist, which is fed by `Config/Shared.xcconfig`, so a
/// household pointing at its own host changes one build setting and nothing else.
struct AppConfig: Equatable, Sendable {
    let baseURL: URL
    let origin: WebOrigin
    let version: String

    enum ConfigError: Error, Equatable {
        case missingBaseURL
        case malformedBaseURL(String)
        case unsupportedScheme(String)
    }

    init(baseURLString: String, version: String) throws {
        let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ConfigError.missingBaseURL }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else {
            throw ConfigError.malformedBaseURL(trimmed)
        }
        guard scheme == "https" || scheme == "http" else {
            throw ConfigError.unsupportedScheme(scheme)
        }
        guard let origin = WebOrigin(url: url) else {
            throw ConfigError.malformedBaseURL(trimmed)
        }
        self.baseURL = url
        self.origin = origin
        self.version = version
    }

    static func load(from info: [String: Any]) throws -> AppConfig {
        guard let raw = info["EddyBaseURL"] as? String else { throw ConfigError.missingBaseURL }
        let short = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        return try AppConfig(baseURLString: raw, version: "\(short) (\(build))")
    }

    static func load(from bundle: Bundle) throws -> AppConfig {
        try load(from: bundle.infoDictionary ?? [:])
    }
}
