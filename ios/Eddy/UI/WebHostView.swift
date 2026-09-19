import SwiftUI
import WebKit

/// The shell's one and only web view.
///
/// Everything it is allowed to load comes from `ShellModel.pendingLoad`, and
/// every navigation it attempts goes through `WebNavigationPolicy` first.
struct WebHostView: View {
    let model: ShellModel

    var body: some View {
        ZStack {
            // Reading `pendingLoad` and `bridgeScript` here — not inside the
            // representable — is what makes SwiftUI re-run the update when a
            // new load is requested.
            WebView(
                request: model.pendingLoad,
                bridgeScript: model.bridgeScript,
                origin: model.config.origin,
                version: model.config.version,
                onStart: model.webViewDidStartLoad,
                onFinish: model.webViewDidFinishLoad,
                onFail: model.webViewDidFail,
                onTerminated: model.webContentProcessTerminated,
                onResetRequested: model.requestIdentityReset
            )
            // Bottom edge only. The PWA's sticky headers pin to `top: 0` with
            // no safe-area padding of their own, so a web view running under
            // the status bar leaves a strip above the header where scrolling
            // content shows through. Stopping at the top safe area clips it;
            // RootView's background fills the strip.
            //
            // `.container` only, so the keyboard still resizes the web view.
            // Left to itself WKWebView copes with the keyboard by shifting its
            // scroll position, which `position: fixed` elements don't follow —
            // the PWA's bottom nav ends up stranded mid-screen.
            .ignoresSafeArea(.container, edges: .bottom)

            // The PWA's own first paint is behind a network round trip, so
            // without this the shell shows a plain colour and nothing else.
            if model.state == .loading {
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(Color.eddyAccent)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.state)
    }
}

private struct WebView: UIViewRepresentable {
    let request: LoadRequest?
    let bridgeScript: String?
    let origin: WebOrigin
    let version: String
    let onStart: () -> Void
    let onFinish: () -> Void
    let onFail: (Error) -> Void
    let onTerminated: () -> Void
    let onResetRequested: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(origin: origin, onStart: onStart, onFinish: onFinish, onFail: onFail,
                    onTerminated: onTerminated, onResetRequested: onResetRequested)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = true
        // Kid-facing: a tap on a video should just play it.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.isElementFullscreenEnabled = true
        // Default (persistent) store on purpose — the PWA keeps transient UI
        // state such as resume position in browser storage.
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "EddyShell/\(version)"

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false

        // No white flash: the web view is transparent over the shell's
        // background, and over-scroll shows the same colour.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.underPageBackgroundColor = UIColor(Color.eddyBackground)

        // The PWA's bottom nav is `position: fixed; bottom: 0` and already
        // leaves room for the home indicator. An automatic safe-area inset on
        // top of that makes the page scroll further than its layout, and the
        // nav drifts off the bottom edge.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // With the accessory bar gone there is no Done button; dragging the
        // results is how the keyboard goes away.
        webView.scrollView.keyboardDismissMode = .onDrag
        webView.removeInputAccessoryView()

        context.coordinator.attachResetGesture(to: webView)
        context.coordinator.apply(bridgeScript: bridgeScript, to: webView)
        context.coordinator.load(request, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.apply(bridgeScript: bridgeScript, to: webView)
        context.coordinator.load(request, in: webView)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, UIGestureRecognizerDelegate {
        private let origin: WebOrigin
        private let onStart: () -> Void
        private let onFinish: () -> Void
        private let onFail: (Error) -> Void
        private let onTerminated: () -> Void
        private let onResetRequested: () -> Void

        private var loadedRequestID: UUID?
        private var injectedScript: String?

        init(
            origin: WebOrigin,
            onStart: @escaping () -> Void,
            onFinish: @escaping () -> Void,
            onFail: @escaping (Error) -> Void,
            onTerminated: @escaping () -> Void,
            onResetRequested: @escaping () -> Void
        ) {
            self.origin = origin
            self.onStart = onStart
            self.onFinish = onFinish
            self.onFail = onFail
            self.onTerminated = onTerminated
            self.onResetRequested = onResetRequested
        }

        // MARK: - Driving the web view

        func load(_ request: LoadRequest?, in webView: WKWebView) {
            guard let request, request.id != loadedRequestID else { return }
            loadedRequestID = request.id
            webView.load(URLRequest(url: request.url))
        }

        /// WebKit zooms the page when an input with a font size under 16px
        /// takes focus (the PWA's search box is 15px and autofocuses). A zoomed
        /// page strands `position: fixed` elements — the bottom nav slides off
        /// the screen until it is scrolled back. An app shell has no use for
        /// page zoom, so the viewport is pinned at 1x.
        private static let lockZoomScript = """
            (function () {
              var meta = document.querySelector('meta[name="viewport"]');
              if (!meta) {
                meta = document.createElement('meta');
                meta.name = 'viewport';
                document.head.appendChild(meta);
              }
              meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
            })();
            """

        func apply(bridgeScript: String?, to webView: WKWebView) {
            guard bridgeScript != injectedScript else { return }
            injectedScript = bridgeScript
            let controller = webView.configuration.userContentController
            controller.removeAllUserScripts()
            controller.addUserScript(
                WKUserScript(source: Self.lockZoomScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            )
            guard let bridgeScript else { return }
            controller.addUserScript(
                WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
        }

        /// Two fingers held for two seconds, anywhere. Deliberately obscure —
        /// it must not collide with the PWA's own bottom nav or header, and a
        /// kid will not produce it by accident. Not a security boundary.
        func attachResetGesture(to webView: WKWebView) {
            let recogniser = UILongPressGestureRecognizer(target: self, action: #selector(handleResetGesture))
            recogniser.numberOfTouchesRequired = 2
            recogniser.minimumPressDuration = 2
            recogniser.cancelsTouchesInView = false
            recogniser.delegate = self
            webView.addGestureRecognizer(recogniser)
        }

        @objc private func handleResetGesture(_ recogniser: UILongPressGestureRecognizer) {
            guard recogniser.state == .began else { return }
            onResetRequested()
        }

        nonisolated func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }

        // MARK: - The kid-safety boundary

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            let url = navigationAction.request.url
            let action = WebNavigationPolicy.Action(
                url: url,
                navigationType: navigationAction.navigationType,
                targetIsMainFrame: navigationAction.targetFrame?.isMainFrame ?? false,
                opensNewWindow: navigationAction.targetFrame == nil
            )

            switch WebNavigationPolicy.decide(action, origin: origin) {
            case .allow:
                decisionHandler(.allow)
            case .loadInPlace(let target):
                decisionHandler(.cancel)
                webView.load(URLRequest(url: target))
            case .openExternally(let target):
                decisionHandler(.cancel)
                Log.navigation.info("Handing off-site link to the system: \(target.host() ?? "?", privacy: .public)")
                UIApplication.shared.open(target)
            case .block:
                decisionHandler(.cancel)
                Log.navigation.notice("Blocked navigation to \(url?.scheme ?? "?", privacy: .public)")
            }
        }

        /// `window.open` reaches here rather than `decidePolicyFor` in some
        /// cases; returning nil means the shell never gains a second web view.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            let action = WebNavigationPolicy.Action(
                url: navigationAction.request.url,
                navigationType: navigationAction.navigationType,
                targetIsMainFrame: false,
                opensNewWindow: true
            )
            switch WebNavigationPolicy.decide(action, origin: origin) {
            case .allow, .loadInPlace:
                if let url = navigationAction.request.url { webView.load(URLRequest(url: url)) }
            case .openExternally(let target):
                UIApplication.shared.open(target)
            case .block:
                break
            }
            return nil
        }

        // MARK: - Load state

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            onStart()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onFinish()
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            onFail(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onFail(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // The model re-mints the load request, which comes back through
            // `load(_:in:)`. `webView.reload()` would be a no-op if the
            // process died before anything committed.
            loadedRequestID = nil
            onTerminated()
        }
    }
}
