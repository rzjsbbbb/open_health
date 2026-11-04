// Open Oura — a native window for the local dashboard (http://127.0.0.1:8090).
//
// It only views: syncing lives in "Open Oura Service.app", which this starts if it
// isn't running, so closing the window never stops syncing. Built by
// tools/macos_app.sh with `swiftc` (no Xcode project needed).
import Cocoa
import WebKit

let dashboardURL = URL(string: "http://127.0.0.1:8090/")!
let serviceApp = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Applications/Open Oura Service.app")

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var retries = 0

    func applicationDidFinishLaunching(_ note: Notification) {
        startServiceIfNeeded()
        buildMenu()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Open Oura"
        window.contentView = web
        window.minSize = NSSize(width: 520, height: 480)
        window.center()
        window.setFrameAutosaveName("OpenOuraMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        load()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // The service owns Bluetooth and the dashboard server; launch it hidden if absent.
    func startServiceIfNeeded() {
        let running = NSWorkspace.shared.runningApplications
            .contains { $0.bundleIdentifier == "io.github.open-oura.service" }
        guard !running, FileManager.default.fileExists(atPath: serviceApp.path) else { return }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = false
        NSWorkspace.shared.openApplication(at: serviceApp, configuration: cfg)
    }

    func load() { web.load(URLRequest(url: dashboardURL)) }

    @objc func reload(_ sender: Any?) { retries = 0; load() }

    // The server may still be starting: show a short notice and retry for ~30 s.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        retries += 1
        guard retries <= 60 else {
            webView.loadHTMLString(notice("仪表盘服务没有响应。请确认「Open Oura Service」在运行,然后按 ⌘R 重试。"), baseURL: nil)
            return
        }
        if retries == 1 { webView.loadHTMLString(notice("正在启动…"), baseURL: nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.load() }
    }

    func webView(_ webView: WKWebView, didFinish nav: WKNavigation!) {
        if webView.url?.host == "127.0.0.1" { retries = 0 }
    }

    func notice(_ text: String) -> String {
        """
        <html><body style="font:15px -apple-system;display:flex;align-items:center;justify-content:center;
        height:100vh;margin:0;color:#888;background:Canvas;color-scheme:light dark">\(text)</body></html>
        """
    }

    // Links that leave the dashboard (PGS Catalog, SNPedia…) open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        if let url = action.request.url, let host = url.host, host != "127.0.0.1",
           action.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }  // target=_blank
        return nil
    }

    // Exports (JSON, research ZIP) are attachments or blob links: save them to Downloads.
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let attachment = (response.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") ?? false
        decisionHandler(attachment || !response.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var dest = dir.appendingPathComponent(suggestedFilename)
        let base = dest.deletingPathExtension().lastPathComponent, ext = dest.pathExtension
        var n = 1
        while FileManager.default.fileExists(atPath: dest.path) {
            n += 1
            dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
        }
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
    }

    // App, Edit (copy/paste in text fields), View and Window menus.
    func buildMenu() {
        let main = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) {
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            let holder = NSMenuItem()
            holder.submenu = m
            main.addItem(holder)
        }
        func item(_ title: String, _ sel: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        submenu("Open Oura", [
            item("隐藏 Open Oura", #selector(NSApplication.hide(_:)), "h"),
            .separator(),
            item("退出 Open Oura(同步继续在后台运行)", #selector(NSApplication.terminate(_:)), "q"),
        ])
        submenu("编辑", [
            item("撤销", Selector(("undo:")), "z"),
            item("重做", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("剪切", #selector(NSText.cut(_:)), "x"),
            item("拷贝", #selector(NSText.copy(_:)), "c"),
            item("粘贴", #selector(NSText.paste(_:)), "v"),
            item("全选", #selector(NSText.selectAll(_:)), "a"),
        ])
        submenu("显示", [item("重新载入", #selector(reload(_:)), "r")])
        submenu("窗口", [
            item("最小化", #selector(NSWindow.miniaturize(_:)), "m"),
            item("关闭", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
