//  PrivacyGuard.swift
//  Two leaks the JavaScript cannot close, closed natively:
//
//  1. The app-switcher snapshot. iOS photographs the screen the moment the
//     app resigns active, and that photograph persists on disk. If it was
//     taken mid-review — or worse, mid seed-phrase — the confirmation screen
//     outlives the airgap. So on willResignActive an opaque cover in the
//     vault's own surface colour drops over the window, and the snapshot
//     shows a black card with the wordmark: true, and empty.
//
//  2. The cover is torn down only on didBecomeActive, which also covers the
//     app-switcher case where the app was never fully backgrounded.
//
//  (The third leak, the clipboard, is closed by never writing to it: no code
//  in app/ or ios/ touches UIPasteboard, and the test suite greps to keep it
//  that way. A vault has nothing to say to the clipboard — addresses leave by
//  QR, and seeds leave by hand.)
//
//  Install from the AppDelegate:  PrivacyGuard.install()

import UIKit

@objc(PrivacyGuard)
public final class PrivacyGuard: NSObject {

  private static var cover: UIView?

  @objc public static func install() {
    NotificationCenter.default.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
    ) { _ in show() }
    NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { _ in hide() }
  }

  private static func show() {
    guard cover == nil,
          let window = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
            .first
    else { return }

    let view = UIView(frame: window.bounds)
    view.backgroundColor = UIColor(red: 0.031, green: 0.031, blue: 0.039, alpha: 1)

    let mark = UILabel()
    mark.text = "LABYRINTH"
    mark.font = .systemFont(ofSize: 14, weight: .semibold)
    mark.textColor = UIColor(red: 0.937, green: 0.918, blue: 0.886, alpha: 0.4)
    mark.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(mark)
    NSLayoutConstraint.activate([
      mark.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      mark.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])

    window.addSubview(view)
    cover = view
  }

  private static func hide() {
    cover?.removeFromSuperview()
    cover = nil
  }
}
