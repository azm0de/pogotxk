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

**The same backslash bypass, a second time — in `safeNext`.** Found by a production audit
*after* the markdown one was fixed. `/auth/login?next=` rejected `//host` and let `/\host`
through, and did not strip the tab/CR/LF the URL parser removes before resolving. Captured
against live production:

```
next=%2F%5Cevil.example        ->  cookie next "/\evil.example"
next=%2F%09%2F%2Fevil.example  ->  cookie next "/\t//evil.example"
next=%2F%2Fevil.example        ->  "/"            (blocked, as intended)
```

`callback.ts` wrote that value straight into `Location` with no second check, and `authorizeUrl`
sends `prompt=none`, so anyone who had already authorised the app completed the entire bounce
with no interaction — a one-click silent redirect off the community's own trusted domain.

> This is the lesson. The bug class was found, understood, fixed and commented in
> `markdown.ts` — and the fix was never carried to the other place the codebase does the same
> thing. Fixing an instance is not fixing a class. When you close one, grep for its siblings.

`safeNext` now lives in `src/lib/auth/next.ts` so both routes share one implementation, the
callback re-validates on the way out rather than trusting its own cookie, and `test-auth.ts`
asserts every captured payload resolves back to our origin.

**ICS `raw()` did not strip control characters**, so a meetup's `campfire_url` could inject
property lines. One malformed line makes a calendar client reject the *whole* feed — so a single
bad meetup would silently break every subscriber.

**Leaving the Discord never cost anyone their role.** `fetchGuildRoles` returned `null` both for
"no guild is configured" and for "Discord answered 404, this person is not a member". The
callback could not tell those apart, so it treated a definitive *no* as *we did not ask* and kept
the stored role. It now returns a discriminated `GuildLookup`; only a real answer is
authoritative. The two nulls were introduced by an earlier correct fix — the one that stopped
hand-promoted admins being demoted — which is how a careful change quietly created a hole.

## Silent wrongness

**Empty calendar feeds in production.** `/api/game/events.json` served 39 events while
`/calendar/game.ics` rendered zero. Both pages fetched that route over HTTP from the Worker's own
origin — a loopback that works against `astro dev` and returns nothing live. The surrounding
`catch` swallowed it, so the feed was well-formed, correctly attributed, and empty.

> Every local check passed. Some classes of bug only exist in production.

**Every calendar subscribe link pointed at a 404.** `site` in `astro.config.mjs` was set to
`https://pokemontxk.com` — the domain the project is *aiming* at — while the site was actually
served from `pogotxk.gnomelabz.workers.dev` and `pokemontxk.com` still ran the old Apache site.
So all six subscribe/webcal links on `/events`, the `SOURCE` line inside every feed, and the
canonical URL on every page named a host that returned 404.

> ICS is subscribe-once. A dead feed URL does not error — it is an empty calendar, forever,
> for anyone who added it. The failure mode is silence.

`site` must name the host that actually serves the site, never the one you intend to move to.
It is now overridable with `SITE_URL` so the cutover is a build variable, and `/events` builds
its links from the request origin, which is guaranteed to resolve. See [[Configuration]].

> [!note] Edge cache will lie to you while verifying
> The first post-deploy check showed the old host and an unblocked payload, and the canonical
> tag showed the new value — on the same deployment. Cache-busted requests showed both fixes
> live. Verify with `Cache-Control: no-cache` and a unique query string before concluding a
> deploy failed.

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

## Caused by a fix, caught before shipping

**Dropping `body_md` from the admin post list would have destroyed posts.** The list query was
hauling every post body to render a list of titles, so it was removed. But the editor populated
its form from that same list row — so opening a post and pressing Save would have written an
empty string over the body. The editor now fetches the body on open, with Save disabled and the
textarea read-only until it lands.

> A performance fix walked straight into data loss. The query change was right; the thing that
> made it dangerous was a consumer three files away that nobody thought to look at. Verified by
> actually opening a post and saving it, not by reading the diff.

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
