// Fluncle's Helm — THE SHIM. A thin native macOS frame around the Helm daemon
// (apps/helm, :4190). The daemon is the whole brain; the shim is only a frame:
// a menu-bar presence, a real Dock-visible window (a WKWebView onto the daemon),
// and daemon custody (kickstart the LaunchAgent, or fall back to the CLI
// launcher). The daemon never knows what frame it is in — Chrome app-mode still
// works, and the shim is optional. Voice: a recovered terminal (VOICE.md, the
// CLI register — deadpan machine states).
//
// One Swift file, macOS 13+. Built on demand by shim/build.sh (swiftc -O); CI
// never touches it (ubuntu runners have no swiftc).
//
// Why the glass loads through a custom `helm://` scheme and not http directly:
// on macOS 15+, WKWebView's network process is gated by Local Network privacy
// and silently drops loopback (127.0.0.1 / localhost) loads, while the app's own
// URLSession reaches the daemon fine. DaemonProxy bridges that gap — it serves
// every WKWebView request through the app's URLSession (streamed, so SSE run
// output flows), so the shim just works with no permission dance.

import AppKit
import WebKit

// MARK: - Config

private enum Config {
  static let port = 4190
  /// The real daemon, for URLSession (health, custody) and "Open in browser".
  static let base = URL(string: "http://127.0.0.1:4190")!
  static let health = URL(string: "http://127.0.0.1:4190/api/health")!
  /// The glass's in-app origin — proxied to `base` by DaemonProxy.
  static let glass = URL(string: "\(DaemonProxy.scheme)://helm/")!
  static let launchAgentLabel = "com.fluncle.helm"
  static let pollInterval: TimeInterval = 30
  static let custodyBudget: TimeInterval = 15
  /// The wheel. "helm" is a real SF Symbol (macOS 13+); the grid-cross is the
  /// documented fallback for older symbol sets.
  static let symbolPrimary = "helm"
  static let symbolFallback = "circle.grid.cross"
  static let windowSize = NSSize(width: 1280, height: 860)
  static let windowMinSize = NSSize(width: 720, height: 520)
  static let frameAutosave = "FluncleHelmWindow"
  /// Deep Field (#090a0b, DESIGN.md) — the window ground under the glass, so a
  /// slow daemon load letterboxes to canon rather than to white.
  static let deepField = NSColor(red: 0x09 / 255.0, green: 0x0a / 255.0, blue: 0x0b / 255.0, alpha: 1)
}

private func debugLog(_ message: String) {
  guard ProcessInfo.processInfo.environment["FLUNCLE_HELM_SHIM_DEBUG"] != nil else { return }
  FileHandle.standardError.write(Data("helm-shim: \(message)\n".utf8))
}

/// The daemon's reachability, as the menu reads it.
private enum Health {
  case up // holding :4190
  case starting // down, but custody is in flight
  case down // down, and nothing is trying
}

// MARK: - DaemonProxy — serve the glass through the app's own URLSession

/// A WKURLSchemeHandler that answers `helm://` by proxying to the real daemon on
/// loopback via URLSession (which is not caught by WKWebView's Local Network
/// gate). Streamed end to end, so an SSE run stream flows chunk by chunk. The
/// daemon sees a plain loopback request (no cross-scheme Origin/Host), so its
/// own auth stays satisfied — loopback needs no helm key.
private final class DaemonProxy: NSObject, WKURLSchemeHandler, URLSessionDataDelegate {
  static let scheme = "helm"
  /// Headers that would confuse the daemon or the re-issued request.
  private static let dropRequest: Set<String> = ["host", "origin", "referer", "cookie", "connection", "content-length"]
  /// Response headers that lie once URLSession has decoded the body.
  private static let dropResponse: Set<String> = ["content-encoding", "content-length"]

  private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
  private var active: [Int: WKURLSchemeTask] = [:] // URLSession task id → the live scheme task
  private let lock = NSLock()

  /// `helm://helm/<path>?<query>` → `http://127.0.0.1:4190/<path>?<query>`.
  private static func map(_ url: URL?) -> URL? {
    guard let url, let src = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    var out = URLComponents()
    out.scheme = "http"
    out.host = "127.0.0.1"
    out.port = Config.port
    out.percentEncodedPath = src.percentEncodedPath.isEmpty ? "/" : src.percentEncodedPath
    out.percentEncodedQuery = src.percentEncodedQuery
    return out.url
  }

  func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
    guard let target = DaemonProxy.map(urlSchemeTask.request.url) else {
      urlSchemeTask.didFailWithError(URLError(.badURL))
      return
    }

    var request = URLRequest(url: target)
    request.httpMethod = urlSchemeTask.request.httpMethod ?? "GET"
    request.httpBody = urlSchemeTask.request.httpBody
    for (key, value) in urlSchemeTask.request.allHTTPHeaderFields ?? [:] where !DaemonProxy.dropRequest.contains(key.lowercased()) {
      request.setValue(value, forHTTPHeaderField: key)
    }

    let task = session.dataTask(with: request)
    lock.lock()
    active[task.taskIdentifier] = urlSchemeTask
    lock.unlock()
    task.resume()
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
    lock.lock()
    let ids = active.filter { $0.value === urlSchemeTask }.map(\.key)
    for id in ids { active.removeValue(forKey: id) }
    lock.unlock()
    session.getAllTasks { tasks in
      for task in tasks where ids.contains(task.taskIdentifier) { task.cancel() }
    }
  }

  private func schemeTask(_ id: Int) -> WKURLSchemeTask? {
    lock.lock(); defer { lock.unlock() }
    return active[id]
  }

  private func drop(_ id: Int) {
    lock.lock(); active.removeValue(forKey: id); lock.unlock()
  }

  // URLSessionDataDelegate — forward to the scheme task on main, guarded against
  // a task that WebKit has already stopped (calling a stopped task would crash).

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void,
  ) {
    let id = dataTask.taskIdentifier
    DispatchQueue.main.async { [weak self] in
      guard let self, let task = self.schemeTask(id) else { return }
      task.didReceive(self.rewrite(response, for: task.request.url))
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    let id = dataTask.taskIdentifier
    DispatchQueue.main.async { [weak self] in
      guard let self, let task = self.schemeTask(id) else { return }
      task.didReceive(data)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let id = task.taskIdentifier
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      if let schemeTask = self.schemeTask(id) {
        if let error, (error as? URLError)?.code != .cancelled {
          schemeTask.didFailWithError(error)
        } else {
          schemeTask.didFinish()
        }
      }
      self.drop(id)
    }
  }

  /// Re-stamp the response with the glass-scheme URL and drop now-false encoding
  /// headers, keeping status + Content-Type so the browser renders it right.
  private func rewrite(_ response: URLResponse, for url: URL?) -> URLResponse {
    guard let http = response as? HTTPURLResponse, let url else { return response }
    var headers: [String: String] = [:]
    for (key, value) in http.allHeaderFields {
      guard let key = key as? String, let value = value as? String else { continue }
      if DaemonProxy.dropResponse.contains(key.lowercased()) { continue }
      headers[key] = value
    }
    return HTTPURLResponse(url: url, statusCode: http.statusCode, httpVersion: "HTTP/1.1", headerFields: headers) ?? response
  }
}

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  private var statusItem: NSStatusItem?
  private var window: NSWindow?
  private var webView: WKWebView?
  private let proxy = DaemonProxy()
  private let statusLine = NSMenuItem(title: "checking the helm…", action: nil, keyEquivalent: "")
  private var healthTimer: Timer?
  private var custodyInFlight = false
  private var lastLoadFailed = false

  // MARK: Lifecycle

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular) // a REAL Dock icon, by design
    buildMainMenu()
    buildStatusItem()
    makeWindow()
    showWindow(nil)

    // First custody: if the daemon isn't answering, raise it, then poll on.
    refreshHealth { [weak self] up in
      if !up { self?.ensureDaemon() }
    }
    startPolling()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    // Cmd-W closes the WINDOW; the shim lives on in the tray + Dock.
    false
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    // Clicking the Dock icon with no window open re-shows the helm.
    if !flag { showWindow(nil) }
    return true
  }

  // MARK: The main menu (Cmd-W / Cmd-Q, since a .regular app owns its menu bar)

  private func buildMainMenu() {
    let mainMenu = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "About Fluncle's Helm",
      action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: "",
    )
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "Quit Fluncle's Helm",
      action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q",
    )
    appItem.submenu = appMenu
    mainMenu.addItem(appItem)

    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(
      withTitle: "Close",
      action: #selector(NSWindow.performClose(_:)),
      keyEquivalent: "w",
    )
    windowMenu.addItem(
      withTitle: "Minimize",
      action: #selector(NSWindow.performMiniaturize(_:)),
      keyEquivalent: "m",
    )
    windowItem.submenu = windowMenu
    mainMenu.addItem(windowItem)

    NSApp.mainMenu = mainMenu
    NSApp.windowsMenu = windowMenu
  }

  // MARK: The menu-bar glyph

  private func buildStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

    if let button = item.button {
      let image = NSImage(systemSymbolName: Config.symbolPrimary, accessibilityDescription: "Fluncle's Helm")
        ?? NSImage(systemSymbolName: Config.symbolFallback, accessibilityDescription: "Fluncle's Helm")
      image?.isTemplate = true // adapts to the menu bar's light/dark appearance
      button.image = image
      button.toolTip = "Fluncle's Helm"
    }

    let menu = NSMenu()
    menu.addItem(actionItem("Open the Helm", #selector(openHelm)))
    menu.addItem(actionItem("Open in browser", #selector(openInBrowser)))
    statusLine.isEnabled = false // a label, not a command
    menu.addItem(statusLine)
    menu.addItem(.separator())
    menu.addItem(actionItem("Quit the shim", #selector(quitShim)))

    item.menu = menu
    statusItem = item
    apply(health: .down)
  }

  private func actionItem(_ title: String, _ selector: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
    item.target = self
    return item
  }

  // MARK: The window

  private func makeWindow() {
    let win = NSWindow(
      contentRect: NSRect(origin: .zero, size: Config.windowSize),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false,
    )
    win.title = "Fluncle's Helm"
    win.isReleasedWhenClosed = false // keep the instance: Cmd-W hides, Dock re-shows
    win.minSize = Config.windowMinSize
    win.backgroundColor = Config.deepField
    win.setFrameAutosaveName(Config.frameAutosave) // restorable frame

    let configuration = WKWebViewConfiguration()
    configuration.setURLSchemeHandler(proxy, forURLScheme: DaemonProxy.scheme)
    let web = WKWebView(frame: NSRect(origin: .zero, size: Config.windowSize), configuration: configuration)
    web.navigationDelegate = self
    web.underPageBackgroundColor = Config.deepField
    win.contentView = web
    web.load(URLRequest(url: Config.glass))

    // Restore the saved frame if there is one; otherwise open centered.
    if !win.setFrameUsingName(Config.frameAutosave) {
      win.center()
    }

    window = win
    webView = web
  }

  @objc private func showWindow(_ sender: Any?) {
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }

  private func reloadWeb() {
    lastLoadFailed = false
    webView?.load(URLRequest(url: Config.glass))
  }

  // MARK: Menu actions

  @objc private func openHelm(_ sender: Any?) {
    refreshHealth { [weak self] up in
      guard let self else { return }
      if !up { self.ensureDaemon() }
      self.showWindow(nil)
    }
  }

  @objc private func openInBrowser(_ sender: Any?) {
    refreshHealth { [weak self] up in
      if !up { self?.ensureDaemon() }
      NSWorkspace.shared.open(Config.base)
    }
  }

  @objc private func quitShim(_ sender: Any?) {
    NSApp.terminate(nil)
  }

  // MARK: Health

  private func startPolling() {
    healthTimer = Timer.scheduledTimer(withTimeInterval: Config.pollInterval, repeats: true) { [weak self] _ in
      self?.refreshHealth()
    }
  }

  /// One async poll of /api/health; updates the glyph + status line on the main
  /// thread, and re-loads the glass if it had failed and the daemon is back.
  private func refreshHealth(then completion: ((Bool) -> Void)? = nil) {
    var request = URLRequest(url: Config.health)
    request.timeoutInterval = 2.5
    request.cachePolicy = .reloadIgnoringLocalCacheData

    URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
      let up = (response as? HTTPURLResponse)?.statusCode == 200
      DispatchQueue.main.async {
        guard let self else { return }
        self.apply(health: up ? .up : (self.custodyInFlight ? .starting : .down))
        if up, self.lastLoadFailed { self.reloadWeb() }
        completion?(up)
      }
    }.resume()
  }

  private func apply(health: Health) {
    switch health {
    case .up:
      statusLine.title = "holding :\(Config.port)"
      tintGlyph(nil) // full strength, menu-bar-adaptive
    case .starting:
      statusLine.title = "daemon down — starting…"
      tintGlyph(.secondaryLabelColor)
    case .down:
      statusLine.title = "daemon down"
      tintGlyph(.tertiaryLabelColor) // dimmed: unreachable
    }
  }

  private func tintGlyph(_ color: NSColor?) {
    statusItem?.button?.contentTintColor = color
  }

  // MARK: Custody — raise the daemon when it is down

  private func ensureDaemon() {
    if custodyInFlight { return }
    custodyInFlight = true
    apply(health: .starting)

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      self.triggerCustody()
      self.waitForHealth(until: Date().addingTimeInterval(Config.custodyBudget))
      DispatchQueue.main.async {
        self.custodyInFlight = false
        self.refreshHealth()
      }
    }
  }

  /// The LaunchAgent is the clean path (daemon-only, no window). Without it, the
  /// CLI launcher is the fallback — it boots the daemon and, in this cold-start
  /// edge only, opens its own browser window too.
  private func triggerCustody() {
    if launchAgentInstalled() {
      runProcess("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(Config.launchAgentLabel)"])
    } else if let fluncle = resolveFluncle() {
      launchDetached(fluncle, ["helm"])
    }
  }

  private func launchAgentInstalled() -> Bool {
    let path = ("~/Library/LaunchAgents/\(Config.launchAgentLabel).plist" as NSString).expandingTildeInPath
    return FileManager.default.fileExists(atPath: path)
  }

  /// Resolve `fluncle` off PATH, with a Homebrew fallback GUI apps often miss.
  private func resolveFluncle() -> String? {
    var dirs = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
    dirs.append(contentsOf: ["/opt/homebrew/bin", "/usr/local/bin"])

    for dir in dirs {
      let candidate = (dir as NSString).appendingPathComponent("fluncle")
      if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    }
    return nil
  }

  /// Poll health on the calling (background) thread until it answers or the
  /// budget runs out — the "starting…" line holds in the menu meanwhile.
  private func waitForHealth(until deadline: Date) {
    while Date() < deadline {
      if synchronousHealthOK() { return }
      Thread.sleep(forTimeInterval: 0.5)
    }
  }

  private func synchronousHealthOK() -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var ok = false
    var request = URLRequest(url: Config.health)
    request.timeoutInterval = 2

    let task = URLSession.shared.dataTask(with: request) { _, response, _ in
      ok = (response as? HTTPURLResponse)?.statusCode == 200
      semaphore.signal()
    }
    task.resume()
    _ = semaphore.wait(timeout: .now() + 3)
    return ok
  }

  @discardableResult
  private func runProcess(_ launchPath: String, _ arguments: [String]) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: launchPath)
    process.arguments = arguments
    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus
    } catch {
      return -1
    }
  }

  private func launchDetached(_ launchPath: String, _ arguments: [String]) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: launchPath)
    process.arguments = arguments
    var env = ProcessInfo.processInfo.environment
    let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    env["PATH"] = env["PATH"].map { "\($0):\(extra)" } ?? extra
    process.environment = env
    try? process.run() // fire-and-forget: the health loop watches for it
  }

  // MARK: WKNavigationDelegate — track load failures so the poll can recover

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    lastLoadFailed = true
    debugLog("provisional load failed: \(error.localizedDescription)")
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    lastLoadFailed = true
    debugLog("load failed: \(error.localizedDescription)")
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    lastLoadFailed = false
    debugLog("loaded \(webView.url?.absoluteString ?? "?")")
  }
}

// MARK: - Entry point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
