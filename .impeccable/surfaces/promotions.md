# W3.5 promotions and cross-file requests (batched from wave reports)

Owner: main thread. **Applied 2026-09-02 (during W2, files disjoint from W2 ownership):** `.prose :where(p)` / `:where(a:not([class]))`; `.btn`/`.chip` on `--font-read`; `--nudge`/`--nudge-back` with reduced-motion escape; `.btn--arrow-back`; `.chip[aria-current]`; standalone `.count`; `.section-head h3`; `--disc-size`; `.badge.target`; `--measure: 60ch`; `--poi-campsite-text` (light/dark); `markdown.ts` table-scroll region; `MapPreview` placeholder ink. Still open below: items marked [ ].

## primitives.css
- [ ] `.btn` and `.chip` pin `font-family: var(--font)` → `var(--font-read)` (W1-D, W1-B worked around locally; remove their overrides after).
- [ ] `.btn--arrow:hover::after { transform: translateX(2px) }` has no reduced-motion escape → `transform: var(--nudge)` with `--nudge: translateX(2px)` in global.css and `none` under reduced motion (W1-D).
- [ ] Promote `.btn--arrow-back` (mirrored arrow; W1-D has a local copy in both blog files).
- [ ] Promote `.chip[aria-current='page']` (a chip that is a link cannot carry `aria-pressed`; W1-D).
- [ ] Promote `.count` as a standalone class (currently only `.section-head .count`; W1-B needs it in `.panel-head` and `<summary>`).
- [ ] `.section-head h3` sizing (primitives size only h2; W1-B).
- [ ] `.badge` + `.target` padding order: `.badge`'s padding lands after `.target`'s in the layer; W1-D restored block padding locally. Decide: `.target` declared after `.badge`, or `.badge.target` rule.

- [ ] **Bug:** `.prose p { margin-block: 0 }` (0,2,0) out-ranks `.prose > * + * { margin-block-start }` (0,1,0), so paragraphs get no rhythm. Fix: `.prose :where(p) { margin-block: 0 }` (W1-E; worked around locally in `legal.css`).
- [ ] **Bug:** `.prose a { color: var(--accent) }` (0,2,0) beats `.btn--primary { color: #fff }` — a button inside prose measured 1.00:1. Fix: `.prose :where(a)` (W1-E; controls moved out of prose on `/account/delete`).
- [ ] Promote `--disc-size` on `.disc` (default 32px; W1-C needs 40px beside a `--display-sm` heading, written locally as `.g-tier .disc, .g-pool .disc`).

## global.css
- [ ] `--poi-campsite-badge: #9e6a27` is 4.62:1 on white but **3.60:1 on `--bg-panel` in dark** (W1-C measured). Split the job: keep `-badge` for a fill under dark text, add `--poi-campsite-text` (light `#9e6a27`, dark `var(--poi-campsite)` = 7.97:1 on the dark panel) for text/icon use, and document both.
- [ ] `--measure: 68ch` ≈ 85 characters in Atkinson → retune to ~58–60ch (W1-D set 58ch locally).
- [ ] Verify the claim that `h1–h4 { font-family: var(--font-display) }` beats `.panel-head h1` (W1-D). The reset is in `@layer reset`, so primitives should win; probe `getComputedStyle(h1).fontFamily` on `/blog` and `/events`. If reset really wins, the cause is layer *order* at bundle time (primitives.css parsed before the `@layer reset, primitives;` statement) — fix by moving the statement into primitives.css's first line as well.
- [ ] Note for W3: the `body`/`h1–h4` defaults flip to `--font-read`/`--font-sign` only in the chrome wave.

## Other files (main thread)
- [ ] `src/lib/markdown.ts:402` emits `<div class="table-scroll">` without `tabindex="0"` / `role="region"` / `aria-label` (W1-D).
- [ ] `src/lib/events.ts` / `src/lib/db/meetups.ts`: recurring meetups group by their anchor start, so a weekly meetup anchored in the past falls into `past` and never reaches the meetups panel (W1-B). **Product bug, not design** — raise with Justin; needs next-occurrence expansion.
- [ ] `src/components/game/game.css` `.g-status--stale` uses `--poi-gym` off the map (W1-B → W1-C should have caught; verify after W1-C).
- [ ] `src/pages/index.astro` ~L2343 comment about `.event-image` cancelling card padding is stale (W1-B → W1-A).

- [ ] `src/lib/game-image.ts` + `src/pages/img/leekduck/[...path].ts`: `proxiedImageUrl()` accepts only `https://cdn.leekduck.com`; the type and weather icons live on `https://leekduck.com/assets/img/...`, so W1-C dropped them to words + hue dots. If the icons are wanted back, add that origin under a distinct path prefix (`/img/leekduck-site/...`) with the same content-type and negative-cache rules; keep `leekduckPath`'s origin check origin-based (W1-C).
- [ ] `Attribution.astro` first paragraph reworded by W1-C ("cached on our own origin, so the pictures on this page do not spend their bandwidth") — both links and the no-ads sentence intact; confirm Justin is fine with the wording.
- [ ] W1-C's current nav chip on the game sub-nav is filled ink, not red (two You-Are-Here reds on one screen would compete); flip if the owner disagrees.

- [ ] **Owner sign-off:** W1-E corrected `/privacy`'s third-parties table (CARTO no longer sees your IP for tiles; tiles are Protomaps + OpenStreetMap served from our own hosting) and `/terms`'s map-data credit to match `basemap.ts`. Legal text — confirm with Justin. Also `/offline` copy was rewritten because the old promise ("anything you have already looked at may still open") was false: `sw.js` caches no page HTML.

- [ ] `src/components/map/MapPreview.tsx:57` placeholder inline `color: var(--text-muted)` measures 2.03:1 on `--map-canvas` in dark; W1-A forced `--ink-700 !important` from the page. Fix in the component (a fixed ink, as `.map-loading` uses) and drop the page override (W1-A).
- [ ] `EventCard.astro` `.event-title-link` is 23px tall, 1px under the floor (W1-A measured) — `min-height: 24px` or `.target` (main thread, W3.5).
- [ ] `MapView.css` `.cluster`/`.cluster-wrap` collide with the `.cluster` primitive — sent to W2-A to rename `.map-cluster`; after that, W1-A's local `.actions` workaround in `index.astro` can go back to `.cluster`.
- [ ] **Owner question:** the GO Fest banner carries no photographer byline in code (the vault says the photo has a named photographer); W1-A kept the caption text as-is rather than invent a credit. Ask Justin for the byline and add it to the `.credit`.
- [ ] Vault/plan drift: the landmark rail and the "Right now" card were dropped in `e814e0d`; `vault/Design System.md` and `Backlog.md` still describe them. Fix in the documenter pass.

## Owner answers (2026-09-03)
- Legal copy corrections (Protomaps/OSM on `/privacy` + `/terms`) and the `/offline` rewrite **stand**.
- GO Fest banner: **no byline needed**; caption stays.
- Leek Duck weather/type icons: **words are fine**; the proxy stays narrow.
- Recurring-meetup grouping bug: **fix now** in this branch, with a test.

## Round 2 (2026-09-03)
- [x] `.badge--warn` (ink plate for irreversible), `.caption` (prose beside a heading), `.btn--danger` and `.badge--retired` (from W4 admin) promoted into `primitives.css`. W4's local copies in `Admin.astro`'s `is:global` block can be deleted at the next admin touch.
- [x] Links are ink + underline site-wide (`global.css` reset); `--accent` only in `.prose`, `.btn--primary`, and deliberate "now" affordances.
- [x] `--display-sm` floor 1.55rem. `--z-skip-link` used. Icons resized to their declared sizes. `auth/login.ts` declared an exclusion.
- [ ] Font preload for Overpass + Atkinson roman in `Base.astro` (after W5-operate releases the file).
- [ ] `DESIGN.md`: links-are-ink Don't; CARTO → Protomaps at L180; the new primitives; admin now in-world (documenter rerun).
- [ ] Admin: real-session confirmation of PATCH on drag/lat-lng, media upload, markdown preview with real posts (Justin).

## Finish reviewer's open items — resolved 2026-09-03
- `/map` locate placement on wide screens: **fixed** (`b38382f`) — sits beside the legend's bottom corner at ≥641px, measured clear of zoom and attribution at 1280.
- `/go` Raid vs Gym takedown icons: **kept**. Raid is the red full-width tile, Gym takedown an outlined tile with the strike arrow; the label is always present, so the icon pair never carries the distinction alone.
- `/live` empty-state pin motif below 640px: **kept off**. At 390 the copy fills the dashed panel; the two arrow buttons are the next step, and no decoration beats a colliding one.
- Signed-in paths (`/go` sheets, populated `/live`, delete success, device approval): **still need Justin's Discord session** — verified with fixtures only.
- Branch policy (Justin, 2026-09-03): `impeccable-redesign` stays a separate design branch; **no push, PR or merge** until he says so.

## Fonts
- [x] Atkinson regular/italic files were swapped at download; swapped back on disk 2026-09-02 (regular = 33,996 B, italic = 37,644 B). Any wave that screenshotted "oblique body text" before the swap should be re-checked.

## Known pane limitation
- Custom-width `resize_window` breaks `navigate`; presets only. True 1280–1440 captures for the finish: try resizing *after* navigation, screenshot, then reset before the next navigate.
