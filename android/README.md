# PoGo TXK — Android app

A thin shell around [pogotxk.gnomelabz.workers.dev](https://pogotxk.gnomelabz.workers.dev) that
adds the one thing a browser cannot do: **a floating bubble that sits on top of Pokémon GO**.

Tap it while you are playing, pick an action, and a flare goes out to the community — without
leaving the game.

## Why this exists as a native app

Android is the only platform that lets a third-party app draw over another one
(`SYSTEM_ALERT_WINDOW` + `TYPE_APPLICATION_OVERLAY`). **iOS has no equivalent** — not in an app,
not in a PWA, not with any workaround. iPhone users get the installable web app at `/go` instead,
which is genuinely good but is not a bubble.

## It never touches the game

This is not negotiable, and it is what keeps the app on the right side of Niantic's terms:

- **No** screen capture, MediaProjection, or accessibility-service scraping
- **No** hooking the game process or reading its memory
- **No** GPS mocking
- **No** Niantic or Campfire API access

It reads your location from the normal Android APIs to work out which gym you are standing at,
and posts to *our* server. Functionally it is a Messenger chat head that happens to know about
PokéStops. Overlay IV checkers have historically drawn bans precisely because they read the
game — this does not.

## How it is put together

| File | What it does |
|---|---|
| `MainActivity.kt` | WebView shell over the site, plus the button that raises the bubble |
| `BubbleService.kt` | Foreground service owning the overlay window — the bubble itself |
| `Api.kt` | Calls the same `/api/flares` the website uses |
| `Nearby.kt` | Picks the nearest gym from a cached POI list |

**There is no second login.** You sign in through Discord in the WebView exactly as you would on
the website, and the bubble reuses that session cookie. A separate credential path would just be
another thing to leak.

## Building

Needs JDK 17–21 (**not** 24 — AGP does not support it yet) and the Android SDK.

```bash
cd android
JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-21.0.8.9-hotspot" ./gradlew assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/`. For a release build use `assembleRelease`;
it is unsigned, so sign it before distributing.

`local.properties` points at your SDK and is gitignored — recreate it with
`sdk.dir=C:/path/to/Android/Sdk` if you clone fresh.

## Installing on a phone

Not on Google Play. Sideload it:

1. Build the APK, or take one from a release
2. Copy it to the phone and open it
3. Allow installing from unknown sources when prompted
4. Open the app, sign in with Discord
5. Tap **Allow the floating bubble** — Android opens its own settings screen for this and will
   not grant it any other way
6. Tap **Turn the bubble on**

The bubble persists until you turn it off from its notification.

## Verified

Built and run on an Android 16 emulator: the overlay window is created and owned by the app
(`ty=APPLICATION_OVERLAY`, `appop=SYSTEM_ALERT_WINDOW`), the service runs foreground with type
`specialUse`, the bubble drags and taps open into the action panel, and firing an action without
a session refuses cleanly rather than crashing.

**Not yet verified on real hardware**, and specifically not over Pokémon GO itself. Some OEM
skins (Xiaomi, Oppo, and others) hide overlay permission in a non-standard place or restrict
background services more aggressively than stock Android.
