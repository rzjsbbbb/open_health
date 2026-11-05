// Open Oura Service's main executable (built by tools/macos_app.sh).
//
// It runs the bundled supervisor script (Contents/Resources/supervise.sh, which keeps
// `oura watch` and `oura dashboard` alive) as a child and stays its parent. That makes
// this app the "responsible process" for everything the script starts, so macOS asks
// once — "Open Oura Service would like to access files in your Desktop folder", and for
// Bluetooth — and remembers it across rebuilds of `oura`.
//
// When the script itself was the app's executable, the responsible process was
// /bin/bash; TCC never prompts on behalf of a platform binary, so it fell back to the
// `oura` binary — whose ad-hoc signature changes with every `cargo build` — and asked
// again for every rebuilt binary, one dialog per process that touched the folder.
import Foundation

guard let script = Bundle.main.url(forResource: "supervise", withExtension: "sh") else {
    FileHandle.standardError.write("supervise.sh missing from the app bundle\n".data(using: .utf8)!)
    exit(1)
}

let child = Process()
child.executableURL = URL(fileURLWithPath: "/bin/bash")
child.arguments = [script.path]
child.terminationHandler = { exit($0.terminationStatus) }

// Pass TERM / INT on to the script: its trap stops watch and dashboard before it exits.
var sources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        if child.isRunning { kill(child.processIdentifier, sig) } else { exit(0) }
    }
    source.resume()
    sources.append(source)
}

do {
    try child.run()
} catch {
    FileHandle.standardError.write("could not start supervise.sh: \(error)\n".data(using: .utf8)!)
    exit(1)
}
dispatchMain()
