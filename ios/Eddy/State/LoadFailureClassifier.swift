import Foundation

/// Decides what counts as "Eddy can't be reached".
///
/// Only a network-class failure puts the native fallback screen up. An HTTP
/// error page served by Eddy itself is the PWA's business and never reaches
/// here; a cancelled or superseded navigation is noise.
enum LoadFailureClassifier {
    static func classify(_ error: Error) -> UnreachableReason? {
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return nil }

        switch nsError.code {
        case NSURLErrorTimedOut:
            return .timeout
        case NSURLErrorCannotFindHost,
             NSURLErrorCannotConnectToHost,
             NSURLErrorNetworkConnectionLost,
             NSURLErrorDNSLookupFailed,
             NSURLErrorNotConnectedToInternet,
             NSURLErrorInternationalRoamingOff,
             NSURLErrorCannotLoadFromNetwork,
             NSURLErrorResourceUnavailable,
             // TLS and ATS. A lapsed certificate on the household's own proxy,
             // or a base URL over plain http, would otherwise be swallowed and
             // left to time out twenty seconds later under the wrong headline.
             NSURLErrorSecureConnectionFailed,
             NSURLErrorServerCertificateHasBadDate,
             NSURLErrorServerCertificateUntrusted,
             NSURLErrorServerCertificateHasUnknownRoot,
             NSURLErrorServerCertificateNotYetValid,
             NSURLErrorClientCertificateRejected,
             NSURLErrorAppTransportSecurityRequiresSecureConnection:
            return .network
        default:
            // Includes NSURLErrorCancelled: an unknown error shouldn't blank a
            // working screen on a guess.
            return nil
        }
    }
}
