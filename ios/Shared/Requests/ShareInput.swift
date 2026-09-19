import Foundation

/// One thing the share sheet handed over, already reduced to a value type.
/// `NSItemProvider` never gets past the extension's loader.
enum SharedItem: Equatable, Sendable {
    case url(URL)
    case text(String)
}

/// Picks what to send to Eddy out of whatever the share sheet produced.
///
/// Pure, and deliberately generous: the YouTube app shares a block of text
/// with a link buried in it, Safari shares a bare URL, and Messages can
/// produce both. The server extracts the first http(s) URL from whatever it
/// is given and decides whether Eddy can fetch it, so this only has to answer
/// "is there anything here worth sending?" — never "is this a YouTube link?".
enum ShareInput {
    /// The exact string to put in the request body, or nil if nothing shared
    /// contains a web link at all.
    static func shareableText(from items: [SharedItem]) -> String? {
        // A real URL attachment beats text, whatever order they arrived in:
        // it is the unambiguous one.
        for item in items {
            if case .url(let url) = item, isWebLink(url) {
                return url.absoluteString
            }
        }
        for item in items {
            if case .text(let text) = item, containsWebLink(text) {
                return text
            }
        }
        return nil
    }

    static func isWebLink(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    /// True when the text holds something the server could pull a URL out of.
    static func containsWebLink(_ text: String) -> Bool {
        webLinkStart(in: text) != nil
    }

    private static func webLinkStart(in text: String) -> String.Index? {
        for scheme in ["https://", "http://"] {
            guard let range = text.range(of: scheme, options: [.caseInsensitive]) else { continue }
            // A scheme with nothing after it isn't a link.
            let rest = text[range.upperBound...]
            if let first = rest.first, !first.isWhitespace, !first.isNewline {
                return range.lowerBound
            }
        }
        return nil
    }
}
