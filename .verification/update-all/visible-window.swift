import AppKit
import CoreGraphics

let pid = Int32(CommandLine.arguments[1])!
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
let visible = windows.contains { window in
    (window[kCGWindowOwnerPID as String] as? Int32) == pid &&
    (window[kCGWindowLayer as String] as? Int) == 0 &&
    (window[kCGWindowIsOnscreen as String] as? Bool) == true
}
print(visible ? 1 : 0)
