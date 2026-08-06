---
tags: [decision, android, ios]
updated: 2026-08-05
---

# Why iOS cannot have a floating bubble

**The original ask:** a small circle on the phone, while playing, offering quick actions like
"flare a gym".

**The constraint:** that is achievable on Android and **impossible on iOS**. Not hard —
impossible. There is no API, in a native app or a PWA, and no workaround.

## Android

`SYSTEM_ALERT_WINDOW` plus `TYPE_APPLICATION_OVERLAY`, hosted by a foreground service. The
Messenger chat-head pattern. Built and verified — see [[Android App]].

## iOS

Apple provides no third-party overlay surface. The closest available:

| Surface | What it gives |
|---|---|
| **Live Activity / Dynamic Island** | Persistent, visible over the game, with tappable buttons |
| **Control Center widget** (iOS 18+) | `ControlWidgetButton` + `AppIntent`, fires without opening the app |
| **Action Button** (15 Pro+) | One physical press |
| **Back Tap** | Double/triple tap the back of the phone → Shortcut |

These are genuinely useful, but none is a bubble, and saying otherwise to iPhone users would be
a promise that cannot be kept.

## What was actually shipped

Both platforms get the **installable web app at `/go`** — thumb-reachable actions, works today,
no store. Android additionally gets the real bubble.

The Live Activity path is deliberately **not built**. It requires a native iOS app, an Apple
Developer account, and App Store review, for a strictly worse version of a thing the web app
already does adequately.

## Say this plainly to users

iPhone users should be told the truth up front rather than discovering it. The web app is the
iOS answer; the bubble is an Android feature.

## See also

[[Android App]] · [[Platform Limits and Traps]]
