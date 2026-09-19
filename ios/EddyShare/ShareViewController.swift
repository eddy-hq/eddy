import SwiftUI
import UIKit

/// The extension's principal class. Hosts one SwiftUI card and guarantees the
/// extension context is completed exactly once, whichever way the card ends.
final class ShareViewController: UIViewController {
    private var hasCompleted = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        let model = ShareCardModel(
            config: try? AppConfig.load(from: .main),
            identity: KeychainIdentityStore(),
            finish: { [weak self] in self?.complete() }
        )

        let host = UIHostingController(rootView: ShareCardView(model: model))
        host.view.backgroundColor = .clear
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)

        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        Task { await model.run(extensionItems: items) }
    }

    /// `completeRequest` rather than `cancelRequest(withError:)` even on a
    /// failure: nothing was returned either way, and an error hands the host
    /// app something it will usually surface as a second, worse alert on top
    /// of the one the card already showed.
    private func complete() {
        guard !hasCompleted else { return }
        hasCompleted = true
        extensionContext?.completeRequest(returningItems: nil)
    }
}
