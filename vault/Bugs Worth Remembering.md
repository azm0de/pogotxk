---
tags: [history, quality]
updated: 2026-08-10
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

## Layout

**Every page scrolled sideways on a phone, and the fix was one property.** At 375px the
document was 544px across — 169px of overhang, on all twelve public routes, in production,
for months.

`nav ul` already had `overflow-x: auto` and a hidden scrollbar. The scrolling nav was
designed correctly from the start. But `nav` is a flex item, flex items default to
`min-width: auto`, and that refuses to shrink below content — so the row stayed its full
433px and shoved the header past the viewport instead of ever scrolling.

```css
.site-header nav { min-width: 0; }   /* the whole fix */
```

> A correct design can be completely inert because of a default two levels away. The nav
> looked right in code review and in every desktop screenshot; nothing short of measuring
> `scrollWidth` against `clientWidth` at a phone width would have caught it.

Worth repeating on any flex child that is supposed to scroll or truncate: `min-width: 0`
(or `min-height: 0` in a column) is almost always required, and its absence fails silently
by growing the parent rather than by erroring.

**Truncating by six pixels.** With `flex: 0 1 auto` the brand gave up six pixels and
rendered "PoGo …" — truncated enough to look like a bug, not enough to save room. Shrinking
that yields nothing legible is worse than not shrinking; the element should be shown in full
or hidden outright.

**A gradient scrim that only reached full strength at the very bottom edge.**
`linear-gradient(transparent, rgb(0 0 0 / 0.82))` behind gallery captions left every line
above the last one sitting on bare photograph, invisible over the brighter shots. A scrim has
to be near-opaque for the whole height the text occupies, not just at its final pixel.

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

**"The landmark tiles are unnamed links."** The accessibility tree from the browser tooling
showed the rail's links with no accessible name at all — which would be a serious defect. But it
showed the same for `.hero-map-open` and the whole socials row, both shipped and both already
through an accessibility pass.

The tell was that every unnamed link wrapped its text in a `<span>`, and every named one had
bare text. Two throwaway `<a>` elements injected into the live page settled it: bare text got a
name, span-wrapped text did not. The reader does not run the accessible-name algorithm through
wrapper elements. Nothing was wrong with the page.

> The tree is also viewport-limited — it lists only what is on screen, which is why the probes
> reported nothing until they were scrolled into view.

**"The header is still the wrong colour."** It was — but the source was right.
`sed -i` and `perl -i` **replace** the file rather than writing in place, which
breaks Vite's file watcher. The dev server carried on serving the CSS from before
the bulk edit, with no error anywhere. The tell was that an Edit-tool change to
the *same style block* was live while the `perl` change to the line below it was
not. Restarting the dev server fixed it instantly.

> Every measurement taken between that bulk edit and the restart was against
> stale styles. Use the Edit tool for source files; if a bulk edit has already
> happened, restart before believing anything you measure.

**An invisible link, shipped to production.** The landmark rail's trailing tile — "See all 104 on
the map" — rendered **white on the page background**. `.place-rail li > a { color: #fff }` is two
classes and beats `.place-more > a { color: var(--accent) }` at one, so the photo tiles' white
label colour won a rule it was never meant to reach.

It went out with the rail and nobody saw it, because that tile sits at the far end of a
horizontally scrolling row — every screenshot I took stopped before it. What found it was
auditing *computed* contrast on the rendered page rather than reading the stylesheet. Fixed with
`li:not(.place-more)`.

> Specificity bugs do not look like bugs in the source. Both rules read correctly on their own;
> only the cascade between them is wrong. Measure the rendered result.

**A token that inverts, used as a surface.** `--accent` is a deep red in light
mode and a *light* red in dark mode, because in dark mode it has to be readable
as link text. Ten components paired `background: var(--accent)` with a hardcoded
`color: #fff`, which is 3.0:1 in dark mode. The site header was one of them, and
it had been wrong since long before the repaint — the old dark accent was a light
blue at ~2.6:1.

Fixed by adding `--accent-solid`, which stays deep in both themes. The same trap
applies to every POI colour: they lift in dark mode for the basemap, so
`--poi-powerspot` behind white text measured 3.18:1.

> A colour token that changes between themes cannot be used for both text and
> filled surfaces. Two tokens, or the pairing silently fails in one theme.

**"72 community photographs."** 72 is the *total*; only 9 are of people. The other 63 are
photographs of the locations. Reported to Justin the wrong way round, and it would have built the
wrong thing — a people-first gallery instead of the landmark rail. See [[Design System]].

> Four of my own wrong calls came from measuring the wrong thing and believing the number.
> Check what the measurement actually means before acting on it — and when a tool reports a
> defect in code that already passed review, suspect the tool before the code.

## See also

[[Platform Limits and Traps]] · [[Migration from the Old Site]]
