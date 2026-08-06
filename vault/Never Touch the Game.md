---
tags: [decision, policy, android]
updated: 2026-08-05
---

# Never Touch the Game

**The rule:** nothing we build ever interacts with Pokémon GO. Not the app, not the website, not
anything added later.

## Non-negotiable

- **No** screen capture, MediaProjection, or accessibility-service scraping of the game
- **No** hooking the game process or reading its memory
- **No** GPS mocking
- **No** scraping Niantic or Campfire APIs

The Android bubble talks to **our** Worker and **our** Discord. Nothing else.

## Why this line specifically

Niantic bans third-party software that accesses the game client or backend. Overlay **IV
checkers** and map scrapers have drawn warnings and shadow bans precisely because they read the
game.

A launcher that never touches it is a different category — functionally a Messenger chat head
that happens to know about PokéStops. But that is only true if it stays true.

## What is at stake

Not our account. **Community members' accounts.** Someone installs a thing we built, and their
trainer gets shadow-banned. That is not a risk worth any feature.

## Practical consequences

- The bubble reads location from normal Android APIs, not from the game
- Raid boss names come from [Leek Duck](https://leekduck.com) via ScrapedDuck, not from Niantic
- A flare's boss is free text a human typed, matched against a public list — never scraped
- Gym state, raid timers and player positions are **not** available and are not worked around

## Distribution

The APK is sideloaded, not on Google Play. A Play listing is possible but adds review overhead
for an overlay-permission app. That is a separate decision, not a blocker.

## Stated publicly

This is written into `/terms` and the Android README, not just the code. If someone finds
something claiming to be ours that does otherwise, it is not ours.

## See also

[[Android App]] · [[Attribution Obligations]]
