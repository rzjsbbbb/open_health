// Draw the app icon (the dashboard favicon: a teal disc with a white ring) as a
// 1024 px PNG. Usage: swiftc icon.swift -o icon && ./icon out.png
import Cocoa

let size: CGFloat = 1024
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
// macOS icon grid: a rounded square inset ~10 %, then the favicon mark inside it
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
NSColor(red: 0.95, green: 0.96, blue: 0.96, alpha: 1).setFill()
NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185).fill()
let teal = NSColor(red: 0x0d / 255.0, green: 0x94 / 255.0, blue: 0x88 / 255.0, alpha: 1)
teal.setFill()
NSBezierPath(ovalIn: NSRect(x: 222, y: 222, width: 580, height: 580)).fill()
let ring = NSBezierPath(ovalIn: NSRect(x: 402, y: 402, width: 220, height: 220))
ring.lineWidth = 64
NSColor.white.withAlphaComponent(0.6).setStroke()
ring.stroke()
img.unlockFocus()

let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
