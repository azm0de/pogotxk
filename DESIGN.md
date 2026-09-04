---
name: PoGo TXK
description: The park's own wayfinding board — white laminated panels bolted over a live trail map, Poké Ball red reserved for here, now and active.
colors:
  red-500: "#e01329"
  red-600: "#d10a1e"
  red-700: "#c8071c"
  red-800: "#b5051a"
  red-900: "#9e0417"
  ink-900: "#0f0f11"
  ink-800: "#1d1d1f"
  ink-700: "#2c2c31"
  ink-600: "#3d3d44"
  accent-solid: "#c8071c"
  accent-contrast: "#ffffff"
  live: "#d10a1e"
  live-text: "#c8071c"
  bg: "#f7f7f8"
  bg-panel: "#ffffff"
  bg-sunken: "#efeff1"
  text: "#1d1d1f"
  text-muted: "#5f5f68"
  border: "#e3e3e6"
  border-strong: "#c7c7ce"
  map-canvas: "#e9e6e0"
  white: "#ffffff"
  black: "#000000"
  discord: "#5865f2"
  poi-pokestop: "#2f7fd4"
  poi-gym: "#e2703a"
  poi-powerspot: "#8257d9"
  poi-campsite: "#f2a33c"
  poi-pokestop-badge: "#2c76c5"
  poi-gym-badge: "#b75b2f"
  poi-campsite-badge: "#9e6a27"
  team-valor: "#e8453c"
  team-mystic: "#3b7dd8"
  team-instinct: "#f2c53d"
typography:
  display:
    fontFamily: "Overpass, system-ui, sans-serif"
    fontSize: "clamp(1.9rem, 1.35rem + 2.75vw, 2.9rem)"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Overpass, system-ui, sans-serif"
    fontSize: "clamp(1.55rem, 1.15rem + 1vw, 1.75rem)"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Overpass, system-ui, sans-serif"
    fontSize: "1.3125rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Overpass, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.06em"
  code:
    fontFamily: "ui-monospace, 'Cascadia Mono', 'Segoe UI Mono', Menlo, monospace"
    fontSize: "0.92em"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "22px"
  pill: "999px"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "6": "1.5rem"
  "8": "2rem"
  "12": "3rem"
  "16": "4rem"
components:
  button-primary:
    backgroundColor: "{colors.accent-solid}"
    textColor: "{colors.accent-contrast}"
    rounded: "{rounded.sm}"
    padding: "0.75rem 1.25rem"
  button-primary-hover:
    backgroundColor: "{colors.red-800}"
    textColor: "{colors.accent-contrast}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.red-700}"
    rounded: "{rounded.sm}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.live-text}"
    rounded: "{rounded.sm}"
  button-danger-hover:
    backgroundColor: "{colors.red-800}"
    textColor: "{colors.white}"
  button-pressed:
    backgroundColor: "{colors.text}"
    textColor: "{colors.bg}"
    rounded: "{rounded.sm}"
  button-discord:
    backgroundColor: "{colors.discord}"
    textColor: "{colors.white}"
    rounded: "{rounded.sm}"
  chip:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: "0.5rem 0.75rem"
  chip-pressed:
    backgroundColor: "{colors.text}"
    textColor: "{colors.bg}"
    rounded: "{rounded.pill}"
  card:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "1rem"
  panel:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "1.25rem"
  badge:
    backgroundColor: "{colors.bg-sunken}"
    textColor: "{colors.text}"
    rounded: "{rounded.xs}"
    padding: "2px 0.5rem"
  badge-warn:
    backgroundColor: "{colors.text}"
    textColor: "{colors.bg}"
    rounded: "{rounded.xs}"
    padding: "2px 0.5rem"
  badge-retired:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.xs}"
    padding: "2px 0.5rem"
  disc:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    size: "32px"
  disc-live:
    backgroundColor: "{colors.live}"
    textColor: "{colors.white}"
    rounded: "{rounded.pill}"
    size: "32px"
---

# Design System: PoGo TXK

## Overview

**Creative North Star: "The Park's Wayfinding Board"**

The site is the physical kiosk sign at the trailhead, rebuilt for a phone. The live map is the ground; everything else is a white laminated panel bolted over it, ruled in black ink, typeset in road-sign gothic. It is read one-handed, outdoors, in daylight, in a glance — so contrast is a floor, targets are large, numerals are tabular, and every action carries a drawn arrow that points somewhere. It refuses the two shapes a Pokémon fan site defaults to: the key-art poster hub and the stat-row hero. There is no marketing key-art wall and no game logo anywhere. The owner reinstated the production home hero — forest clip, wordmark, stat row — on 2026-09-04 as a recorded deviation, so the refusal stands for every other surface.

The palette is a Poké Ball taken literally: a red top, a white bottom, a black band. White panels carry the content, ink carries the type and the rules, and red is rationed. Red never decorates — it appears only for *here, now and active*: the You-Are-Here marker, a live flare, the current page in the nav, an RSVP you have pressed. Links are part of the ink, not part of the red: the global reset sets every `a` to `color: inherit` with a `--border-strong` underline, so a page of links reads as a printed page, and red keeps its one job. Because the whole brand is now red, red alone is never allowed to carry meaning; every state also carries a word or a shape, so the board survives greyscale, colour blindness, and a cracked screen in sunlight.

The two typefaces are chosen as materials, not decoration. Overpass descends from the Highway Gothic on every US road and park sign — it is the object this design is built from — and carries all signage: headings, numerals, labels, the running head. Atkinson Hyperlegible Next was drawn by the Braille Institute for low-vision reading and carries all body and UI text. The accessibility floor is worn as a face, not bolted on. Both are preloaded from our own origin in `Base.astro`, so the first paint is already in the world's own type.

The world now covers the whole site, not just its public face. `Admin.astro` imports `primitives.css`, and the editors are built from `.btn`, `.badge`, `.chip`, `.panel` and `.prose` on a 60px ink bar; the two primitives the admin islands used to hand-roll (`.btn--danger`, `.badge--retired`) have been promoted into the shared vocabulary.

**Key Characteristics:**
- White panels on a warm-grey map ground; a soft real shadow lifts each panel off the board.
- Poké Ball red reserved for here / now / active; ink for structure; links underlined in ink, never red.
- Road-sign display type (Overpass 800) over hyperlegible body type (Atkinson Hyperlegible Next).
- Counts rendered as black-ringed white discs; tabular numerals everywhere numbers line up.
- An arrow drawn (never a glyph) on every action; the board reads at arm's length in daylight.
- Accessibility is the material: 4.5:1 in both themes, 24px targets, a reduced-motion escape on every animation.
- One vocabulary front and back: the admin editors are built from the same primitives as the board.

## Colors

A three-colour Poké Ball — red, white, black — held to a strict role split, with a set of map-only wayfinding hues that answer to shape as well as colour.

### Primary
- **Signal Red** (`#c8071c`, `--accent` / `--accent-solid` / `--red-700`): the here/now/active colour and the only accent on the page. Every red in the ramp sits at hue 353–354°, approached from the crimson side — the fire-engine red of an actual Poké Ball. A red at hue 2–6° reads as orange or brick and was rejected on sight; keep green below blue in any new red. `--accent` **inverts** in dark mode to a light red (`#ff5c6e`) so it can be read as link text on a dark page; `--accent-solid` stays this deep red in **both** themes and is the only red allowed under white text (5.99:1).
- **Red ramp** (`--red-500` `#e01329` → `--red-900` `#9e0417`): five measured steps from 4.89:1 to 8.46:1 on white. The obvious brand reds (`#ff0000`, `#ee1515`, `#e3350d`) all fail AA and are deliberately not in the ramp; it starts at the first red that passes. `--red-800` (`#b5051a`) is the primary-button hover and the `.btn--danger` hover fill (7.00:1 under white).

### Secondary
- **Live Red** (surface `--live` `#d10a1e`, text `--live-text` `#c8071c`): the "happening now" signal. Two tokens because one colour cannot both be a filled surface under white text and be legible text on the page — they pull in opposite directions and invert between themes. Kept one step hotter than `--accent` so a flare reads hotter than a button. `--live-text` also carries `.btn--danger`'s outline, because destructive is the one non-"now" state allowed a red, and only as a stroke.
- **Discord Blue** (`#5865f2`, `--discord`): a brand colour, not a palette colour — used only on the one button that means "go to Discord" (white on it measures 4.61:1). It appears nowhere else.

### Tertiary — map wayfinding hues
- **POI pins** (`--poi-pokestop` `#2f7fd4`, `--poi-gym` `#e2703a`, `--poi-powerspot` `#8257d9`, `--poi-campsite` `#f2a33c`): the four place types, distinct in hue *and* silhouette so the map is readable in greyscale and to colour-blind users. Tuned as large pins on the light basemap (WCAG's 3:1 non-text bar). **Not** lifted in dark mode: the basemap is pinned light in both themes, so lifting them would put pale pins on pale tiles.
- **POI badge / text surfaces** (`--poi-*-badge`, `--poi-*-text`): the same hues scaled down in sRGB (hue held to the decimal) until white text clears 4.5:1 on the badge fill, because 11px white on a raw pin colour fails. Use these — never the raw pin colour — for a type badge or type text. `--poi-campsite-text` inverts in dark mode; the others are pinned to the light value.
- **Team colours** (`--team-valor` `#e8453c`, `--team-mystic` `#3b7dd8`, `--team-instinct` `#f2c53d`): used sparingly; `--team-instinct` is darkened via `color-mix` before use as text.

### Neutral
- **Ink** (`--ink-900` `#0f0f11` → `--ink-600` `#3d3d44`): the Poké Ball's black band — the third colour, what stops a red-and-white site from going all-red. Surfaces and chrome, not accent. `--text` is `--ink-800` (16.83:1 on white).
- **Panel white / page grey** (`--bg-panel` `#ffffff`, `--bg` `#f7f7f8`, `--bg-sunken` `#efeff1`): the laminated-panel white on the near-white page. Dark theme: `#1e1e22` panel on `#141416` page.
- **Literal white** (`#ffffff`, `colors.white`): declared as a value in its own right, not only as a token alias. It is the correct literal in exactly two places — text on a *measured* filled surface (`--accent-solid`, `--live`, `--discord`, a `--poi-*-badge`, `--red-800`), where the comment beside it carries the ratio; and the ring drawn around a map pin, which must stay white against every tile the basemap can paint under it.
- **Literal black** (`#000000`, `colors.black`): never a text or surface colour. It appears only as a mask/gradient stop (the drawn arrow and pin masks, the credit scrim) and as the alpha channel of the shadow and scrim vocabulary — `rgb(0 0 0 / 0.14)` through `rgb(0 0 0 / 0.55)`. Black is a *shading material* here, not a palette colour.
- **Map ground** (`--map-canvas` `#e9e6e0`): the colour behind the tiles, a warm pale grey close to the basemap's own land tone. Deliberately theme-independent and never `--bg-sunken`, so a tile still loading reads as "loading" rather than as a dark hole in the map. (The token's own comment still names CARTO Voyager, which the build no longer uses: the tiles are our own Protomaps vector tiles over OSM data, served same-origin from R2 via `src/components/map/basemap.ts`. The value is right, the stated reason is stale.)
- **Borders** (`--border` `#e3e3e6`, `--border-strong` `#c7c7ce`), **muted text** (`--text-muted` `#5f5f68`, 6.32:1 on white). `--border-strong` doubles as the resting underline colour for every link.

### Named Rules
**The Rationed Red Rule.** Red is reserved for here, now and active — the You-Are-Here marker, a live flare, the current nav page, a pressed RSVP. **A link is not "now."** Links are ink everywhere — the global reset gives every `a` `color: inherit` and a `--border-strong` underline that darkens to `currentColor` on hover; `.prose` links get a thicker `--text-muted` underline for presence inside a paragraph; the map's licence credit links are ink on their pill. `--accent` as a text colour survives in exactly two places — `.btn--primary`'s fill (white on `--accent-solid`) and `.btn--ghost`, which is reserved for an affordance that is genuinely "now" (a live-board link while flares exist) and never for wayfinding to another page — and any new use has to argue it is answering "where am I / what is live". The second-round finish review counted a dozen red words in one phone screen of `/about` under a `.prose` exemption; that exemption is gone.

**The `--accent-solid` Rule.** Any filled surface carrying white text uses `--accent-solid` (or `--live`, or `--red-800`, or a `-badge` POI token), never `--accent` and never a raw pin hue. `--accent` inverts to a light red in dark mode; `background: var(--accent)` + `color: #fff` is a 3.0:1 failure there — a trap six components (the header among them) shipped once.

**The Second-Signal Rule.** Colour is never the only signal. Every state that has a hue also has a word or a shape: flares carry a spelled-out badge, POI types differ in silhouette, the live disc carries a pulse and the word "Live", the `/live` connection pill spells out Connected / Live / Reconnecting rather than changing colour alone.

**The Ink-Plate Warning Rule.** Irreversible and destructive things wear ink, not red. `.badge--warn` is an ink fill with page-colour text; `.btn--danger` is an outline in `--live-text` that only fills red on hover. A fourth meaning for red would blunt the three it already carries.

## Typography

**Display / Signage Font:** Overpass (`--font-sign`, with `system-ui` fallback) — Highway Gothic heritage; headings, numerals, labels, the running head.
**Body / UI Font:** Atkinson Hyperlegible Next (`--font-read`, with `system-ui` fallback) — Braille Institute low-vision face; body copy and all UI text.
**Code face:** the OS mono stack (`ui-monospace, 'Cascadia Mono', 'Segoe UI Mono', Menlo, monospace`) — declared, not shipped. There is no third webfont; inline code and device codes borrow the platform's own monospace so a token, key or ID reads unambiguously without another 30KB download.

Overpass and Atkinson are SIL OFL 1.1, self-hosted as variable-weight woff2 with the licence text beside each file (no font CDN), preloaded in `Base.astro` with `font-display: swap`. The italic is not preloaded; it is fetched only if italic text renders.

**Character:** Road signage over a reading aid. Overpass is confident, structural, and set heavy (800) with negative tracking so a heading reads as a sign. Atkinson is wide, unambiguous, and open — built to survive sunlight and a cracked screen.

### Hierarchy
Two ramps, on purpose. The **UI ramp is fixed rem** (`--text-2xs` 0.6875rem → `--text-xl` 1.3125rem): these are chips, labels and meta read at arm's length in sunlight, and a fluid size there only makes small text smaller on the worst device. The **display ramp is fluid** (`--display-sm` → `--display-xl`), every middle term written `rem + vw` (never bare vw) so it respects the reader's root font size — a WCAG 1.4.4 exposure the old per-page H1 clamps all carried.

- **Display** (Overpass 800, `--display-lg` clamp 1.9–2.9rem, lh 1.08, tracking -0.02em): the hero and largest panel titles. `--display-xl` is reserved for the home hero.
- **Headline** (Overpass 800, `--display-sm` clamp 1.55–1.75rem / `--display-md`, lh 1.2, tracking -0.015em): panel and section heads (`.panel-head h1/h2`, `.section-head h2`, `.prose h2`). The **1.55rem floor** is load-bearing: at the old floor an h2 and the 1.3125rem h3 beneath it collapsed to nearly the same size on a phone and the hierarchy disappeared.
- **Title** (Overpass 800, `--text-xl` 1.3125rem): sub-section heads (`.section-head h3`, `.prose h3`).
- **Body** (Atkinson 400, `--text-base` 1rem, lh 1.55): paragraph text, capped at `--measure` **60ch** — not the textbook 68, because Atkinson's wide letterforms fit ~1.25 characters per ch and 68ch measured 85–96 characters a line.
- **Label** (Overpass 700, `--text-2xs` 0.6875rem, tracking 0.06em `--tracking-caps`, uppercase): badges, the You-Are-Here caps label, micro-labels only — never a sentence.
- **Code** (mono stack, 0.92em, `--radius-xs`, `--bg-sunken` plate): inline code in `.prose` and the device-pairing code. Not a display face and never a heading.

### Named Rules
**The Tabular Numerals Rule.** Anything that is a count, a time, or a tally is set `font-variant-numeric: tabular-nums` (discs, counts, meta). Numbers on this site line up in columns and do not jitter as they change.

**The Signage-Heading Rule.** Headings are signage: Overpass at 800 with tight tracking, never the body face and never a lighter weight. If it is an `h1`–`h4` it is set in `--font-sign`.

**The Caption-Is-Not-A-Count Rule.** Prose beside a heading is `.caption` (muted, `--text-sm`); a number beside a heading is `.count` (muted, `--text-sm`, 600, tabular). They look similar and are not interchangeable — `.count` was being borrowed for phrases, which put tabular figures on running words.

## Layout

A centred column model over a full-width map. `.container` caps content at `--container` (1100px) with a fluid `--gutter` (clamp 0.75–1.5rem); `--container-wide` (1180px) and `--container-narrow` (900px) exist for the map board and legal columns. Prose is capped tighter at `--measure` 60ch.

Spacing is a single rem scale (`--space-1` 0.25rem … `--space-20` 5rem) plus four fluid rhythm tokens (`--space-section`, `--space-band`, `--gutter`, `--gutter-lg`) that replace hand-rolled clamps value-for-value. Two layout primitives compose everything else: `.stack` (vertical rhythm via `> * + *`, gap `--stack-gap`) and `.cluster` (wrapping flex row, gap `--cluster-gap`). Any flex or grid child holding long text, a table, or a scroll region needs `min-width: 0`, or `overflow-x: auto` silently does nothing — a trap that once put 169px of horizontal overflow on every route at 375px.

Two header heights, two tokens, never confused: `--header-public-h` steps 72px → 64px at 430px for the public red bar; `--header-h` is the admin bar's 60px. The skip link sits at `--z-skip-link` (2000), above every sticky rail.

**Recurring board layouts:**
- **The board (home) fits one screen.** A GO Fest banner plate capped at 180px (220px from 900px up), the live map as the ground at `clamp(240px, 42dvh, 380px)`, then a white `.panel` of two numbered `.post`s — the next meetup, with its cover art, and the flares tally. The budget is an 812px fold on a phone, and it is met by measurement, not by feel. Section order is the owner's and is changed only in markup, never with CSS `order`, so reading order and focus order match the screen. Post 1 leads with the meetup's own name, not a category word.
- **The tier ladder (`/raids`) and its two siblings.** Raid bosses as a ladder, hardest tier first (5★ leads), the star count acting as the post number. The sticky `JumpRow` rail (`src/components/game/JumpRow.astro`) is now shared by `/raids`, `/eggs` and `/research` — one 56px row of chips that scrolls sideways rather than wrapping, bolted under the header so it stays readable from anywhere on a 20,000px page.
- **The meetups-first events board (`/events`).** Today's meetups render first as `.post`s with a date block; the 60-row global game calendar is folded into a disclosure below them. Every event card leads with the event's own name. The game calendar's three groups (In progress, Upcoming, Recently finished) render as the same poster cards as the home calendar, two abreast at the same 768px breakpoint (owner's call, 2026-09-04).
- **The live log (`/live`).** The board's now-panel: a timestamped log where states print themselves, headed by a connection pill that spells Connected / Live / Reconnecting.
- **The action panel (`/go`).** A six-tile action grid (`nav.go-actions`) for raising a flare, Raid largest and drawn first (`go-action--primary`, icon 32px vs 26px), each tile a drawn flare icon over a label; the first thing on the screen, above the fold, opened from the Android bubble over the game.
- **The legend (`/map`).** A white panel bolted over the board, titled "Legend & filters", whose legend strip stays visible whether the panel is open or shut — each row a coloured dot, an ink silhouette, and the word (dot + shape + word), and it keys **every** symbol the map can draw, not just the four POI types. Choosing a place closes the drawer and marks its row as current. The locate flash prints beside the button that caused it, not somewhere else on the board. A tile watchdog asks the tile store directly and prints a line when the basemap never arrives, because neither Leaflet event says so.
- **The home map preview is a picture, not a map.** In `compact` mode markers are non-interactive, scroll-wheel zoom and keyboard control are off, the photo layer is not built, and the panel does not auto-open on a tile failure. It is a strip of the real park you look at and then tap through to `/map`.

Responsive: the public header collapses its nav into a `.nav-toggle` panel below 820px, and the account control rides inside that panel as its last row rather than staying in the bar.

## Elevation & Depth

A hybrid: flat ink borders for structure, a soft neutral shadow to lift a laminated panel off the board. Panels sit on `--shadow-md`; borders and 2px ink rules do the structural work. Shadows are neutral, never brand-tinted — a red-tinted shadow under a red button reads as a glow, not a shadow. Dark mode deepens every shadow opacity to hold the same read on a dark ground. All depth alphas are black at low opacity, `rgb(0 0 0 / 0.14)` to `rgb(0 0 0 / 0.55)` across shadows and the credit scrim.

### Shadow Vocabulary
- **`--shadow-sm`** (`0 1px 2px rgb(0 0 0 / 0.08)`): resting lift on small chrome.
- **`--shadow-md`** (`0 4px 16px rgb(0 0 0 / 0.12)`): the panel shadow — a sign bolted over the board.
- **`--shadow-lg`** (`0 12px 40px rgb(0 0 0 / 0.18)`): sheets and overlays.

### Named Rules
**The Neutral-Shadow Rule.** Shadows are always neutral black at low alpha, never tinted with the accent, and always soft. Depth is a shadow; a coloured glow is a different, unwanted thing.

**The Ink-Rule Rule.** Structure inside a panel is a 2px solid `--text` (ink) bottom border — under panel heads, section heads, and `.prose h2`. Depth lifts the panel; ink divides its contents. A hairline `--border` rule is the quieter form, used above fine print such as the Attribution block.

## Shapes

Softly rounded rectangles, ink-ruled. Radii step `--radius-xs` 4px (badges, code) → `--radius-sm` 8px (buttons, small surfaces) → `--radius` 14px (panels, cards) → `--radius-lg` 22px (large surfaces), with `--radius-pill` 999px for chips and discs. Two silhouettes recur and carry meaning: the **disc** (a perfect circle, black ring, tabular numeral inside — a legend key; sized by `--disc-size`, 32px by default, 40px on the game pages, 20px in the media library) and the **teardrop map pin** (shared between the map markers and the drawn flare icons, so a raid tile and a gym marker read as the same object). Borders are ink for structure (2px `--text`), quiet grey for containment (`--border` on cards), and dashed grey for a quiet empty state.

## Components

### Buttons (`.btn`)
- **Character:** a confident signpost; body-face at weight 700, 44px min-height, a 2px border that is part of the shape.
- **Shape:** `--radius-sm` (8px), `--btn-radius` overridable.
- **Primary** (`.btn--primary`): `--accent-solid` fill, white text (5.99:1 both themes); hover fills `--red-800`.
- **Danger** (`.btn--danger`): destructive and irreversible — transparent with a `currentColor` border in `--live-text`, filling `--red-800` under white on hover (7.00:1). Never a red fill at rest: a filled red button is the primary action's shape. Promoted out of three admin islands that each hand-rolled it.
- **Outline / Ghost / Discord / Block / Small:** `.btn--outline` (transparent, `currentColor` border), `.btn--ghost` (transparent, `--accent` text), `.btn--discord` (`--discord` fill, white text), `.btn--block` (full width), `.btn--sm` (32px min-height).
- **States:** hover lifts `var(--lift)` (translateY -2px), active `var(--press)` (scale 0.97); `[aria-pressed="true"]` inverts to ink fill / page-colour text — the same move a chip makes, so "I'm coming" looks different from "I could come"; disabled (`:disabled` or `[aria-disabled]`) drops to 0.6 opacity with no transform.
- **The arrow:** `.btn--arrow` appends a drawn arrow (masked SVG on `currentColor`, sized 1em on the text baseline) that nudges `var(--nudge)` +2px on hover; `.btn--arrow-back` prepends the mirrored arrow, nudging `var(--nudge-back)`, for "Newer" / "All news" returns.

### Chips (`.chip`)
- **Style:** interactive pill (`--radius-pill`), 36px min-height, 1.5px `--border-strong` border, panel-white fill, body-face 600.
- **State:** hover darkens the border to `--text`; `[aria-pressed="true"]` (a control) and `[aria-current]` (a link marking the current place — a jump-row target, a chosen legend row) both invert to ink fill / page-colour text — one inverted state that holds in both themes without a second token.

### Cards & Panels
- **Panel** (`.panel`): the world's container — a sign bolted over the board. Panel-white, `--radius` (14px), `--shadow-md`, `--space-5` padding (`--panel-pad`). `.panel-head` is a baseline-aligned flex row with a 2px ink bottom rule; its `h1`/`h2` are Overpass 800 at `--display-sm`. `.panel--flush` zeroes padding.
- **Card** (`.card`): surface only, for lists *inside* a panel — panel-white, 1px `--border`, `--radius`, `--space-4` padding (`--card-pad`, cancellable to bleed an image). Layout belongs to the consumer. Cards in a grid row stretch to equal height; prefer wrapping over truncation.
- **Poster card** (`EventCard` `art="poster"`, the home calendar and the `/events` game calendar): the artwork is the whole 16:9 card and the words sit on it at the foot in white, with no scrim and no provenance plate — the whole card is the link, and the licence credit is the Attribution block under the list. Legibility rides on the letters: the **Halo Rule** — a one-pixel ink outline (eight unblurred 1px text-shadow offsets) under two tight and two soft blurred layers. Blur alone is not enough: at every convex corner a Gaussian fades to a quarter of its edge strength, and a blur-only stack measured 5–17% of glyph edges under 4.5:1 over pale key art. The outline makes the pixel outside every edge solid ink by construction; the blur only softens where it meets the picture. Badges over art are outlined white with the same outline through chained `drop-shadow`s. Measured in `.impeccable/review/poster-halo.json`. A past poster (the `/events` calendar's own state, never seen on home) gets its own carve-out: the picture desaturates and dims, the words stay full white — `.event-card[data-state='past']`'s muted title and `--bg-sunken` ground are written for the thumbnail card and are specific enough to leak onto a poster's white text and `--ink-800` fallback ground otherwise. An event whose only upstream art is Leek Duck's generic placeholder (the Pokémon GO logo, refused) falls back to the site's own key art by event type instead — raids and battles to the raid key art, Community Day to the outing key art, everything else to the PokéStop key art — owner's call, 2026-09-04. Two of those three collages are themselves Niantic posters carrying the official "Pokémon GO" wordmark in one corner and a copyright line along an edge, and a 16:9 poster shows a 16:9 picture whole, logo included — so the PokéStop and outing pictures are enlarged about a fixed anchor corner (`--fallback-zoom` about `--fallback-anchor`, both set per bucket in `fallbackArt()`) until the wordmark and the copyright line are cropped out of frame; the raid key art carries neither and stays at zoom 1.

### Badges (`.badge`)
- **Style:** a small printed label — static, never interactive (use a chip for controls). Overpass 700 uppercase at `--text-2xs`, `--radius-xs`, sunken-grey fill by default (`--badge-bg`).
- **Variants:** `.badge--outline` (transparent, `currentColor` border) — also the form provenance takes: where an event came from is a *printed plate*, not a second link competing with the card's own. `.badge--live` (`--live` fill, white text) for now. `.badge--warn` (ink fill, page-colour text) for irreversible and destructive things — deliberately not red. `.badge--retired` (outlined, `--text-muted`) for a status that is over: archived, cancelled, past.

### Navigation (header)
- **Style:** a red bar — the Poké Ball's red top — with a 4px near-black `border-bottom` as the band and the white page below. Nav items are chips; labels in `--font-sign`. The Poké Ball mark is the brand once per bar; the mobile menu does not repeat it.
- **Current page** (`nav a[aria-current="page"]`): inverts to a white chip carrying a printed red disc in an ink ring (`::before`, 10px, drawn with a box-shadow ring so it costs no layout) with a lifting shadow. This is the You-Are-Here marker restated on the bar as a *sign* — and it deliberately does **not** pulse; only the live map marker animates.
- **Go chip** (`.nav-highlight`): the one black nav chip, distinct from the white current-page chip (a white chip already means "current").
- **Mobile:** below 820px the nav collapses into a `.nav-toggle` panel whose button wears three ink rules at the header's own foreground — a drawn menu mark, not a glyph. The account control — the sign-in pill, or a signed-in member's avatar-and-name control — rides as the panel's last row under a hairline, and signed in it opens in place as an accordion rather than a floating dropdown. With the account out of the bar, the Menu button takes the bar's right edge. Desktop (≥821px) is unchanged.

### Admin chrome
The editors are in the world, not beside it. `Admin.astro` imports `primitives.css` and builds from `.btn`, `.badge`, `.chip`, `.panel` and `.prose` under a 60px ink bar (`--header-h`). Lists use `.admin-row`, a grid of name / when / status / actions that stacks below its breakpoint. Anything an editor needs that the primitives lack is written locally with a `PROMOTE:` comment and batched into `primitives.css` later; the two notes that carried `.btn--danger` and `.badge--retired` have been redeemed.

### You-Are-Here marker (`.here`) — signature
The board's one animated thing: an inline caps label (Overpass 800, uppercase, `--tracking-caps`) preceded by a red `--accent-solid` disc in a double ring (panel-white then ink, via layered box-shadows) that pulses `here-pulse` (scale 1→1.18, 1.6s, infinite). Marks the user's position on the map, and reads **"Live now"** on a live meetup or flare — one word for one shape: `.here` says "Live now", `.badge--live` says "Live now", the live board's pill says "Live"; "Happening now" and "Running now" are retired for this signal. Has a `prefers-reduced-motion` escape that stills the pulse.

### Numbered post & disc (`.post` / `.disc`) — signature
A waypoint post: a 2-column grid of a lookup disc and its body. `.disc` is a circle at `--disc-size` (32px default), 2px ink ring, panel-white, Overpass 800, tabular numerals — a legend key, so it earns its place and is never used for decoration. `.disc--live` fills `--live` with white text for a "now" post. `.disc--strong` fills ink with an inverted numeral and marks the top rungs of a *ranked* set — the 5-star, Mega and Shadow tiers on the raid ladder — never a member of a flat set. This is the counts-as-discs rule of the world.

### On-image press credit (`.figure` / `.credit`) — signature
A press credit that rides *on* its photograph (a licensing obligation — it must survive a crop). `.credit` is absolutely positioned along the image's bottom edge over a five-stop black gradient scrim (0.93→transparent), white text with a text-shadow, measured at 4.50–19.38:1 with 0% of the text area under 4.5:1. The two-stop scrim it replaced sat at 2.50:1 where the glyphs actually are. The parent `.figure` must be `position: relative; overflow: hidden`.

### Prose (`.prose`)
Long-form markdown and legal text, capped at `--measure` (60ch). Ink-ruled `h2` at `--display-sm`, `--space-4` inter-block rhythm via `:where()` at zero specificity (so the rhythm wins and a `.btn` inside prose keeps its own colour). The `.prose :where(p) { margin-block: 0 }` reset must be written **before** the `> * + *` rhythm rule: both resolve to (0,1,0), so the tie goes to source order, and with the reset last every direct-child paragraph measured 0px of spacing and the copy ran together. `.prose` links are ink with a 1.5px `--text-muted` underline (the Rationed Red Rule admits no running-text exemption). Wide tables wrap in `.table-scroll` (keyboard-reachable) and keep their semantics.

### Attribution (`Attribution.astro`)
The licence notice for every page built on Leek Duck / ScrapedDuck data. Fine print set over a hairline rule, below the content it credits — small and quiet, but never conditional. Render it outside every empty-state branch on any page touching that data.

### Empty state (`.empty-state` / `.empty-art-bg`)
A status, not an invitation: dashed `--border-strong`, quiet muted text, min-height 108px. Put the invitation in a solid panel with a real button instead. `.empty-art-bg` lays a faint map-pin motif behind it — our own SVG pins as a `currentColor` mask, never a photograph, because a press credit cannot ride on a faded background.

## Do's and Don'ts

### Do:
- **Do** reserve red for here / now / active, and pair every stateful colour with a word or a shape (the Second-Signal Rule).
- **Do** let links be ink: `color: inherit` with a `--border-strong` underline that darkens on hover. A red link is a claim that the link is "now".
- **Do** use `--accent-solid` (or `--live`, `--red-800`, or a `--poi-*-badge` token) for any filled surface under white text; `--accent` and raw pin hues invert or fail in one theme.
- **Do** dress destructive and irreversible things in ink and outline — `.badge--warn`, `.btn--danger` — and let red stay the "now" colour.
- **Do** add any new colour to `global.css` as a token with its measured contrast ratio in a comment; the only literals allowed in a component are `#fff` on a measured fill, `#fff` on a pin ring, and black as a mask stop or shadow alpha.
- **Do** write hover/press transforms as the motion tokens (`var(--lift)`, `var(--press)`, `var(--nudge)`, `var(--nudge-back)`) so the `prefers-reduced-motion` block — which sets each to `none` — zeroes them structurally; a scoped `:hover { transform }` survives the blanket duration reset and still jumps.
- **Do** put an arrow (`.btn--arrow`, or `.btn--arrow-back` for a return) on an action that goes somewhere, and set counts as `.disc`s with tabular numerals.
- **Do** give a long game-data page the sticky `JumpRow`; a page over a few screenfuls with no rail is 23 screens with no marker on them.
- **Do** lead a card, post or event with the thing's own name, not its category.
- **Do** measure a "fits one screen" claim against the 812px fold with real element heights, the way the home board's banner / map / panel budget is written down in its own comment.
- **Do** keep the basemap light in both themes and never cover the map's OSM attribution; render `Attribution.astro` outside every empty-state conditional on any page using Leek Duck data.
- **Do** write a missing primitive locally with a `PROMOTE:` comment and batch it into `primitives.css`; both the public board and the admin editors now draw from that one file.

### Don't:
- **Don't** "correct" the reds toward the brand reds (`#ff0000`, `#ee1515`, `#e3350d`) — they fail AA and were deliberately excluded; and don't let green rise above blue in a new red (it drifts orange).
- **Don't** use red as decoration, a section accent, a link colour, or a non-"now" hover colour.
- **Don't** collapse `--live`/`--live-text` or `--accent`/`--accent-solid` into one token, or lift the POI pin hues in dark mode (the basemap is light in both themes).
- **Don't** confuse the two header tokens: `--header-public-h` is the red public bar, `--header-h` is the admin bar's 60px.
- **Don't** use `.count` for a phrase or `.caption` for a number.
- **Don't** write the `.prose` paragraph reset after the rhythm rule; equal specificity means source order decides and the copy loses all its spacing.
- **Don't** let `--display-sm` fall below 1.55rem — on a phone the h2 and the 1.3125rem h3 collapse into each other.
- **Don't** use the Pokémon GO logo, game key-art as a marker, or a font CDN; map markers are original SVGs and both webfonts are self-hosted and preloaded.
- **Don't** put a press photograph anywhere a credit cannot ride on the image (no faded backgrounds, no decorative collages) — use the `.empty-art-bg` map-pin motif instead.
- **Don't** reorder the home sections with CSS `order`; move them in markup so reading and focus order match the screen.
- **Don't** make the home map preview interactive — no wheel zoom, no keyboard, no photo layer, no auto-opening panel. It is a picture of the park with a tap-through.
- **Don't** write new work against `--font-display` (a deprecated migration alias for `--font-sign`) or reach for `:global(.btn)` to restyle a primitive — set a wrapper custom property (`--btn-pad-inline`, `--card-pad`, `--panel-pad`, `--disc-size`) instead.

### Recorded deviations (intentional, not precedent)
- **The home page runs the production hero again — forest clip, wordmark and stat row — on the owner's call (2026-09-04), replacing the 2026-09-03 masthead and board-plate.** A full-bleed `.hero-band.art-band` plays a forest clip behind a scrim, poster stills standing in for reduced motion, data saver, and any browser that never starts the clip; the scrim keeps the contrast floor under the white copy that sits on it. Inside, the wordmark raster is the page's h1 in a left column with the lede, the two action buttons and the four survey counts; the live map sits square on the right, bottom-aligned with the buttons. Below 820px the two stack: the clip becomes a strip behind the mark and the map card goes 4:3. The board panel below — two posts, no arrows of its own now that the hero's own buttons carry the two actions — is bolted `--space-12` (48px) into the band's dissolving foot, and the GO Fest group shot now leads "The community" section rather than opening the page. Shiny Lucario is the band's artwork only for as long as the forest is not up; Mew and Magikarp are untouched. The owner's call, recorded as a deviation and not as precedent.
- **The home calendar's four rows are posters, not calendar rows.** Art as the card, white words with the Halo Rule outline, no scrim over the picture and no Leek Duck plate — the owner wanted the picture to be the card. Extended to the `/events` game calendar on the owner's call, 2026-09-04: the two boards are now one pattern rather than a deviation only home carried.
- **The arrow row sits above the three posts on the home board.** A signpost normally carries its arrow after what it names, but this is the only arrangement in which both the arrow *and* the first post's RSVP clear the 812px fold on the target phone. Documented at the call site.
- **The closing "See you at the park" panel is gone; its event card is the home board's post 1 now (owner's call, 2026-09-04).** The next meetup's cover art, name, time and place and its RSVP used to repeat at the foot of the page in a second panel; the owner liked that panel and asked for it folded into the board instead of kept in both places, so post 1 carries the art the closing panel used to. Its "Open the map" button did not come with it — the hero's own map button already sits a scroll above. Recorded as a deviation, not precedent.
- **The home preview draws ~100 unclustered pins.** Clustering is a control, and `compact` is a picture; a cluster bubble in a non-interactive strip is a button that does nothing.
- **The current-nav disc does not pulse.** Only the live map marker animates. Two pulsing reds would make neither mean "now".
- **`/live` keeps the Leek Duck attribution even when the log is empty**, because the board fetches boss sprites on load — the licence obligation is incurred before there is anything to show.
- **Two exclusions from the design-system detector**, recorded in `.impeccable/config.json`: `src/pages/auth/login.ts` and `src/pages/api/admin/import-legacy.ts`. Both are self-contained diagnostic pages that ship their own inline styles and are deliberately outside the world.
