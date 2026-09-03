---
version: 1
slug: "src-pages-index-astro"
primary_target: "src/pages/index.astro"
related_targets: ["src/layouts/Base.astro","src/pages/map.astro","src/pages/go.astro","src/pages/live.astro","src/pages/events.astro","src/pages/raids.astro","src/pages/eggs.astro","src/pages/research.astro","src/pages/blog/index.astro","src/pages/blog/[slug].astro","src/pages/about.astro","src/pages/conduct.astro","src/pages/privacy.astro","src/pages/terms.astro","src/pages/offline.astro","src/pages/account/delete.astro","src/pages/auth/device.astro","src/pages/auth/error.astro"]
---

# Surface brief — `/` and the public site

## Scope and mode

Home is the world-defining surface (Persuade). Every other public route inherits the world: `/map` `/go` `/live` (Operate), `/events` `/raids` `/eggs` `/research` `/blog` `/blog/[slug]` `/about` `/conduct` `/privacy` `/terms` `/offline` `/account/delete` `/auth/device` `/auth/error` (Operate/Read), plus the chrome in `Base.astro`. Admin is excluded.

## Audience, job, action

A Texarkana player on a phone, one hand, outdoors, in daylight. Job: know what is on in the park right now and where to go. Action: open the map, RSVP to the next meetup, or raise/join a flare. Proof: the real map with 104 surveyed places, the GO Fest photograph with its credit, tonight's meetup with a place and a time.

## Constraints that bind every wave

Poké Ball palette as tokenised (red only for here / now / active). Leek Duck + ScrapedDuck credit outside every empty-state conditional; press credits ride on the image; no Pokémon GO logo; no font CDN; basemap always light; home section order changed only in markup; map attribution never covered; 4.5:1 in both themes, 24px targets, reduced-motion escape on every animation.

## Direction contract

THESIS: The site is the park's own wayfinding board: the map is the ground and everything else is a panel bolted over it. It refuses the key-art poster hub and the stat-row hero.

OWN-WORLD: White laminated panels on the basemap's warm grey; Poké Ball red only for here, now and active (You Are Here, live, current page); black ink rules and type; Overpass (Highway Gothic heritage) for signage display, Atkinson Hyperlegible Next for body; tabular numerals; counts as black-ringed white discs; an arrow on every action.

STORY: A stranger sees the real park, where they are, what is on now, and one arrow to follow. A member finds tonight's meetup in one glance.

FIRST VIEWPORT: A full-viewport live map behind everything; a white panel rising over its lower third carrying three numbered posts (next meetup with RSVP, flares live now, the survey tally) and one arrow-button, Open the map; the brand typeset as a small engraved plate top-left.

FORM: Trail-map kiosk, candidate 1 of 7, taken as the pick card; seed key 66621003.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Signature interaction and motion grammar

The board stays; the panels move. On home the map is fixed behind the page and the white panels scroll up over it like signs bolted over a board (mobile first: this is the game's own bottom-sheet gesture). The You Are Here marker (red disc, black ring, caps label) is the one animated thing: it pulses on the map for the user's position and marks the current page in the nav. Panels arrive with one exponential ease-out (`--ease-out`, `--dur-4`); arrows nudge 2px on hover (`--lift`); under `prefers-reduced-motion` the map is static, panels do not slide and the marker does not pulse.

## Cross-surface reach

`/map` is the board itself with the filter drawer as its legend (dot + shape + word, and a persistent legend strip). `/events` is today's board: meetups as numbered posts first, the global calendar folded below a disclosure. `/raids` is a tier ladder, 5★ first, the star count as the post number. `/blog` is the notice board: dated panels. Legal pages are plain panels with a running head. `/live` is the board's now-panel, a timestamped log where states print themselves. `/go` is the action panel, Raid largest.

## Unresolved

Whether the header keeps the wordmark image beside the typeset brand for a transition period. Whether `/events` folds the global calendar by default on desktop as well as mobile.
