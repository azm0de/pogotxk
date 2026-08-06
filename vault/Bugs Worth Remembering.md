---
tags: [history, quality]
updated: 2026-08-05
---

# Bugs Worth Remembering

Defects found during the build that a reasonable person would ship. Kept because the *shape* of
each recurs.

## Security

**Markdown URL allowlist accepted `/\host`.** The regex rejected `//host` but not `/\host`.
WHATWG URL parsing folds a backslash into a slash for http(s), so `[x](/\evil/p)` rendered as a
same-origin href that resolves offsite — and in the RSS path it emitted a fully-qualified offsite
URL, making `![](/\evil/px.png)` a tracking pixel served to every feed reader.

The module comment asserted the control was closed. Its own 33 checks tested the `//` variant and
missed the backslash one.

> Testing that a control *works* is not the same as testing it *cannot be bypassed*. The
> replacement test resolves each emitted URL and asserts its origin, rather than
> pattern-matching the markup.

**ICS `raw()` did not strip control characters**, so a meetup's `campfire_url` could inject
property lines. One malformed line makes a calendar client reject the *whole* feed — so a single
bad meetup would silently break every subscriber.

## Silent wrongness

**Empty calendar feeds in production.** `/api/game/events.json` served 39 events while
`/calendar/game.ics` rendered zero. Both pages fetched that route over HTTP from the Worker's own
origin — a loopback that works against `astro dev` and returns nothing live. The surrounding
`catch` swallowed it, so the feed was well-formed, correctly attributed, and empty.

> Every local check passed. Some classes of bug only exist in production.

**A cron with no handler.** `*/30 * * * *` was declared before any `scheduled()` export existed.
Cloudflare would have invoked it and failed every thirty minutes, forever, into an
observability-enabled Worker. Removed — the feed cache self-heals on read.

**The head slot was never rendered.** Both blog pages declared `<Fragment slot="head">` and
`Base.astro` had no `<slot name="head" />`, so feed autodiscovery and every article timestamp
were dropped. Invisible in a browser.

**The home page was still the scaffold.** `index.astro` said "Scaffold online." from the first
commit until nearly the end — the front door of the site, never revisited while building
everything behind it.

## Regressions introduced while improving something

**Map popups closed every 60 seconds.** Adding `liveFlares` to the marker-sync dependencies
rebuilt every marker on each refresh, which destroys any popup open on them. Someone reading a
popup would have watched it vanish. Fixed by mutating icons in place instead, guarded so an
unchanged marker is not touched at all.

**Deep links opened nothing.** Focusing a marker on a timer raced the rebuild, and a marker still
inside a collapsed cluster ignores `openPopup()` outright.

**Reconnect backoff never escalated.** It reset on socket `open` rather than on a connection
proving stable, so a flapping socket retried roughly once a second forever — each cycle firing a
D1-backed fetch — and never reached the polling fallback.

## Quietly broken config

**`DISCORD_CLIENT_ID` deleted itself.** Added as a plain-text var; every subsequent deploy wiped
it. `IMPORT_TOKEN` survived because it was a Secret. Symptom: "Discord sign-in is not configured"
despite it being configured. See [[Configuration]].

**The offline page was never cached.** The service worker listed `/offline`, which 307s to
`/offline/`; `Cache.put()` rejects redirected responses. The one page whose entire job is working
when nothing else does, silently absent — and `Promise.allSettled` swallowed the error.

**Filter panel visible while reporting collapsed.** `.panel-body { display: grid }` outranks the
UA's `[hidden] { display: none }`, so `aria-expanded="false"` and actual visibility disagreed.

## Mine, and instructive

**"markers.js is corrupted."** It was not — a Windows console rendering artifact. The planned
"fix" would have corrupted clean data. See [[Migration from the Old Site]].

**"The deploy is broken."** It was not — I was testing a frozen per-version preview URL.

**"Zero live pins."** They were inside map clusters and simply not in the DOM. Chasing it anyway
surfaced the real popup bug underneath.

> Three of my own wrong calls came from measuring the wrong thing and believing the number.
> Check what the measurement actually means before acting on it.

## See also

[[Platform Limits and Traps]] · [[Migration from the Old Site]]
