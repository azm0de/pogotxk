---
tags: [android, feature]
updated: 2026-08-05
status: needs-hardware-testing
---

# Android App

Source in `android/`. A thin shell around the website that adds the one thing a browser cannot
do: **a floating bubble on top of Pokémon GO**.

## Shape

| File | Does |
|---|---|
| `MainActivity.kt` | WebView over the site, plus the button that raises the bubble |
| `BubbleService.kt` | Foreground service owning the overlay window — the bubble itself |
| `Api.kt` | Calls the same `/api/flares` the website uses |
| `Nearby.kt` | Picks the nearest gym from a cached POI list |

**No second login.** Sign-in happens through Discord in the WebView and the bubble reuses that
session cookie. A separate credential path would just be another thing to leak.

## Why a foreground service

The overlay has to outlive our own UI — its entire purpose is being usable while another app is
in front. Android 14 requires a justification for `specialUse`, declared in the manifest.

## Two details that matter

**The drag handler needs a movement threshold.** A thumb always slides a few pixels, so without
one every tap registers as a drag and the panel never opens.

**`FLAG_NOT_FOCUSABLE`** keeps the game underneath receiving input. Without it the overlay
swallows the keyboard and back button.

## Building

Needs **JDK 17–21** — not 24, AGP does not support it. The Android SDK is already installed on
this machine.

```bash
cd android
JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-21.0.8.9-hotspot" ./gradlew assembleDebug
```

Debug APK ~6.2 MB; release minifies to ~1.85 MB and is unsigned.

`local.properties` is gitignored — recreate with `sdk.dir=C:/path/to/Android/Sdk`.

## Installing

Sideload. Not on Google Play — see [[Never Touch the Game]] for why that is a separate decision.

1. Copy the APK to the phone and open it
2. Allow installing from unknown sources
3. Open the app, sign in with Discord
4. **Allow the floating bubble** — Android opens its own settings screen and will not grant it
   any other way
5. **Turn the bubble on**

It persists until turned off from its notification.

## Verified

On an Android 16 emulator:

- Overlay window created and owned by the app — `ty=APPLICATION_OVERLAY`,
  `appop=SYSTEM_ALERT_WINDOW`
- Service foreground with type `specialUse`
- Bubble renders over the launcher and expands into 🔥 Raid · 📣 Invites · 👋 Here · ✕
- Firing an action without a session refuses cleanly rather than crashing
- Debug and release both build with zero warnings

## Not verified

> [!warning] Real hardware, and Pokémon GO itself
> An emulator home screen is a fair proxy for "draws over another app", not proof. Some OEM
> skins (Xiaomi, Oppo) bury overlay permission somewhere non-standard and kill background
> services more aggressively than stock Android.

Also untested: behaviour across a screen rotation, and the bubble surviving a low-memory kill.

## See also

[[Why iOS cannot have a floating bubble]] · [[Never Touch the Game]] · [[Flares and Realtime]]
