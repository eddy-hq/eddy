import ObjectiveC
import UIKit
import WebKit

extension WKWebView {
    /// Removes WebKit's form accessory bar (previous / next / done) that sits
    /// above the keyboard whenever a web input has focus. The PWA has one
    /// input per screen, so the arrows do nothing and the bar reads as a
    /// second, broken navigation.
    ///
    /// WebKit offers no switch for this. The bar is the `inputAccessoryView`
    /// of the private content view inside the scroll view, so the only route
    /// is to re-class that one instance with a subclass that returns nil.
    /// If WebKit's internals change the lookup fails and the bar simply
    /// comes back — nothing else depends on this.
    func removeInputAccessoryView() {
        guard let contentView = scrollView.subviews.first(where: {
            String(describing: type(of: $0)).hasPrefix("WKContent")
        }) else { return }

        let subclassName = "\(type(of: contentView))_EddyNoAccessory"
        if let existing = NSClassFromString(subclassName) {
            object_setClass(contentView, existing)
            return
        }

        let selector = #selector(getter: UIResponder.inputAccessoryView)
        guard let original: AnyClass = object_getClass(contentView),
              let subclass = objc_allocateClassPair(original, subclassName, 0),
              let method = class_getInstanceMethod(UIView.self, selector)
        else { return }

        let noAccessory: @convention(block) (AnyObject) -> UIView? = { _ in nil }
        class_addMethod(subclass, selector, imp_implementationWithBlock(noAccessory), method_getTypeEncoding(method))
        objc_registerClassPair(subclass)
        object_setClass(contentView, subclass)
    }
}
