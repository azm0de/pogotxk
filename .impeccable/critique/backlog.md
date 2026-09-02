# Redesign backlog — merged from critique + audit (2026-09-01)

Source reports: `critique-home-chrome.md`, `critique-map-go-live.md`, `critique-content-hubs.md`, `critique-quiet-pages.md`, `critique-detector.md`, `audit-public.md`, `audit-admin.md` (admin: later pass). Each line: severity | wave owner | file:line | finding. Waves refer to the plan (`W0` foundation, `W1-A` home, `W1-B` events, `W1-C` game, `W1-D` blog, `W1-E` quiet, `W2-A` map, `W2-B` live, `W2-C` go, `W3` chrome).

## P0 — obligations and task-blocking

| Wave | Location | Finding |
|---|---|---|
| W1-C | `RaidCard.astro:31,57`, `EggCard.astro:45`, `ResearchCard.astro:36`, `TypeChips.astro:26` | 72/74 images on `/raids` hotlinked from leekduck.com; route through `proxiedImageUrl()`; add `.g-art` fallback |
| W1-D | `blog/index.astro:698-699, 725-740` | Gallery shows no photographs at desktop: captions cover 97–115% of 190px tiles; keep only the credit on-image |
| W1-D | `blog/[slug].astro:124, 257-261` | Post hero credit rendered beneath the image — must ride on it |
| W1-B | `events.astro:138-141`, `lib/events.ts groupEvents` | 60 vendor cards, zero meetups findable; meetups get their own band; Meetups / Everything toggle |
| W2-A | `MapView.css:940-956` | OSM/Protomaps credit structurally occluded by the filter drawer at 375 (open and closed) |

## P1

| Wave | Location | Finding |
|---|---|---|
| W1-A | `index.astro:1571-1577` | "Next meetup" — the conversion module — has the smallest heading on the page (12.48px muted caps); two h2 treatments max |
| W1-A | `index.astro:462-534, 2155-2346` | "Happening now": four full-bleed Niantic cards, 8 off-site links; cap to two small cards below meetup + community |
| W1-A | `index.astro:844-861` | Page ends on a glossary entry and a disclaimer; end on the ask |
| W1-A | hero | First viewport is 38% Pokémon GO logotype over Niantic key art; direction decides the hero (owner: unpinned) |
| W1-B | `EventCard.css:185-192` | Card hierarchy inverted: banner largest, title 1.06rem, time 0.86rem, group headings 0.82rem muted |
| W1-C | `game.css:154-156` | `.g-fact--boosted dd` `--poi-gym` on white = 3.15:1 (measured, light) |
| W1-C | `game.css:304-307` | `.g-shiny` `--poi-campsite` on white = 2.08:1; only visible shiny carrier |
| W1-C | `game.css:278-300` | Tier "ramp" has no ordinal direction and reuses map tokens; give tiers their own ascending ramp + shape |
| W1-C | `raids.astro:189-193, 272-279` | Three siblings, three architectures; `/raids` hero is a solid black box at 375; 5-star at y=2,169 — drop heroes, add tier jump-row |
| W1-E | `auth/device.astro:244, 292-306` | `hidden` defeated by `display: grid/inline-flex` — hidden button is focusable; add `[hidden]{display:none!important}` in W0 |
| W1-E | `legal.css:59-62` vs `:16, :26, :107` | `.legal p` (0,1,1) beats `.legal-eyebrow/.legal-updated/.legal-note` (0,1,0): muted styles render at full contrast |
| W1-E | `auth/error.astro:26-33, 56-65` | Leads with `ERROR 400`; raw reason louder than the explanation; "Back to the map" → `/`; actions don't adapt to reason |
| W1-E | `legal.css:72-79` | `display:block` on `<table>` strips table semantics; wrap in a focusable scroll region |
| W2-C | `QuickActions.tsx:846` | Six `disabled` tiles swallow the tap signed out; route to `/auth/login?next=/go&action=…` |
| W2-C | `QuickActions.css:76` | Three sign-in affordances; raw `#5865f2` — one sign-in, tokenised `--discord` |
| W2-C + W2-B | `QuickActions.tsx:28-30` vs `lib/db/flares.ts:30-32` | Two flare-raising UIs, two label sets; one label source (`FLARE_KIND_LABEL`), one compose component |
| W2-B | `LiveBoard.tsx:881-884` | Empty state offers no next step; add map + next meetup + push toggle |
| W2-B | `LiveBoard.css:96-97` | Sign-in prompt and empty state are the same dashed card |

## P2

| Wave | Location | Finding |
|---|---|---|
| W1-A | `index.astro:167,195,199` | Home discards `stale`/`fetchedAt`; render `FeedStatus` in "In game today" |
| W1-A | `index.astro:1703-1718, 1731, 1475` | Five sizes ≤12.16px; `.mini-name` truncates 6/12 boss names; let wrap, floor ~12px |
| W1-A | `index.astro:1739-1751` | 24px fix landed on the `<p>`; `.card-links a` 18px, `.footer-links a` 16px |
| W1-B | `EventCard.astro:141-150` | 60 redundant "Details" buttons (120 off-site links, ~130 tab stops) |
| W1-B | `events.astro:219-242` | No `FeedStatus`; bespoke credit at 98% of page height without the no-ads clause; use `Attribution.astro` |
| W1-C | `game.css:76-86` | `/research` rows leave ~250px voids (stretch); `/eggs` rarity/shiny identical across a pool |
| W1-D | `blog/index.astro:764-771, 621`, `[slug].astro:228-231` | `.photo-where a` 15px ×9; tag links 18.8px; unconditional `·` before date |
| W1-E | `legal.css:30-36`, `conduct.astro:100-108`, `error.astro:56-62`, `device.astro:277-284`, `legal.css:100-108` | One callout in four meaningless colours; one `.callout` with info/warn/status variants |
| W1-E | `offline.astro:10-21, 29, 34-36` | No cached-route links, dead nav, all-muted centred copy, no `online` listener |
| W1-E | `device.astro:37-38`, `privacy.astro:110-111` | Astro whitespace trim: "tapApprove", "messages.Discord" — `{' '}` |
| W1-E | `device.astro:186` | 300s code deadline never shown; add a visible countdown |
| W2-A | `MapView.css:963-967`, `MapView.tsx:878-908, 1071-1072` | Locate button top-corner on phones; status sr-only only |
| W2-A | `MapView.tsx:561-591` | Nine photo pins above the functional layer, unfilterable |
| W2-A | `MapView.tsx:1051` | No legend; list rows differ by colour alone |
| W2-C | `QuickActions.tsx:27-32` | Emoji icon system; no primary tile — Raid full-width, SVGs in the marker vocabulary |
| W2-C | `.go-board` | ~400px of void above the grid; raise the grid |
| W2-C | `QuickActions.tsx:856-864, 952-960` | `aria-modal` sheets with no focus management |
| W2-B | `global.css:463-469` at 375 | `.empty-art-bg` pins land on wrapped copy |

## P3 / minor
Clusters announce as a bare number and no `invalidateSize()` (`MapView.tsx:549-554`); `.go-gate` border `#f2a33c`; `.blog-tag-count` 3.22:1; `/about` stats wrap 3+1 at 375; `.lede` 1.05rem; `.btn` ×2 in auth with different min-heights; safety copy duplicated in `conduct`/`terms`; `/conduct` PDF link below the fold; `window.confirm()` on delete; delete success no closure; no print stylesheet; Moltres cropped at the viewport edge on `/live`; "© ©" in attribution; raw hexes `MapView.css:162, 220`; datalist generics leak on `/go`; "Location off — pick manually" reads as an error; `.g-chip--type` 15% tint; rarity legend far from dots; `.event-badge` "Event" from upstream heading.

## Systemic (addressed by W0 + the direction)
- No type scale (39 sizes), no spacing tokens, six `.btn`s, five cards, six badge vocabularies, four section headers.
- `--poi-*` tokens carry four meanings off the map (Gym / boosted CP / stale border / location icon; Campsite / 5-star / shiny / gate border). Lock `--poi-*` to the map; game pages get their own ramp.
- Verification has been dark-first; every measured AA failure is in light mode.
- Discord blurple `#5865f2` appears raw in three files; measured 4.61:1 → token `--discord`.
- The `border-left` callout convention ×8 with no meaning attached (detector `side-tab`).
- 24px target fix pattern applied inconsistently (padding on wrappers instead of anchors).

## Audit (public) findings — 15/20, measured

| Sev | Wave | Location | Finding |
|---|---|---|---|
| P1 | W0 + W1-A/W1-E/W2-A | `index.astro:1912, 1003`, `about.astro:148`, `MapView.css:374` | Press-credit scrims 2.50 / 3.21 / 4.10 / (5.34 by luck):1 — one shared on-image credit class using `/blog`'s five-stop ramp + text-shadow (**W0 ships the class; owners adopt it**) |
| P1 | W1-C | `game.css:154-156` | `--poi-gym` as text 3.18:1 → `--poi-gym-badge` |
| P1 | W2-A | `MapView.css:455` (missing rule) | `.leaflet-container .leaflet-popup-content a { color: var(--accent) }` — 3.36:1 dark today |
| P1 | W2-A | `MapView.css:881-883` | Attribution link 4.02:1 dark; measure against the 88% pill over the light canvas |
| P1 | W0 + W2-A + W3 | `global.css:330-339`, `MapView.css:58-69`, `Base.astro:560, 753` | Reduced-motion kill freezes the map loader and jumps the header animations; give the loader a non-animated alternative, exempt scroll-timeline animations |
| P1 | W3 / W1-A / W1-E / W1-D | `Base.astro:453-459, 928`; `index.astro:1743`; `legal.css:110-133`; blog tag/where links | ~20 standalone links 15–20px tall; promote the 24px pattern to a `global.css` utility (**W0**) and apply |
| P2 | W0 | `global.css` | Add `--poi-campsite-badge`; `.mini-shiny` 1.81:1 |
| P2 | W2-A | `MapView.tsx:1036` | h1 → h3 skip |
| P2 | W1-B | `events.astro:107, 220-238` | Replace hand-rolled credit with `<Attribution />` outside any conditional |
| P2 | W1-E / W1-A | `about.astro:39-43`, Discord avatar | Image dimensions |
| P2 | W1-A | `index.astro:1026-1049` | Release `will-change` (at least under reduced motion) |
| P3 | W3 / W2-A | `Base.astro:662, 879`, `MapView.css:117` | Cancel hover transforms under reduced motion — solved structurally by W0's `--lift` token |
| P3 | W2-A | `MapView.tsx:698, 707` | `userPos` in rebuild deps; `poiBySlug` map |
| P3 | later | `public/icons/*.png`, `og-default.png` | Recompress (not a redesign task) |
| P3 | W1-B | `EventCard.css:75-92` | Use `--poi-powerspot`, delete stale rationale |
| P3 | W1-B | `events.astro:306-311` | Stale scrim comment |
| P3 | W2-C | `go.astro:42` | `BubbleControl` → `client:idle` |
| P3 | W2-A | `MapView.css:575-576` | Measure `backdrop-filter` on low-end Android before keeping |

Verified closed and to be **kept closed** by every wave: zero horizontal overflow on 18 routes × 375/390/430 and at 125/150% root font; keyboard path with visible rings on every stop; key-art hero scrims above 4.5:1 at every pixel; `aria-expanded` ↔ display agreement on the map panel.
