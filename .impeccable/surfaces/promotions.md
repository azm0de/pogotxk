# W3.5 promotions and cross-file requests (batched from wave reports)

Owner: main thread, applied serially after W2, before W3.

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

## Fonts
- [x] Atkinson regular/italic files were swapped at download; swapped back on disk 2026-09-02 (regular = 33,996 B, italic = 37,644 B). Any wave that screenshotted "oblique body text" before the swap should be re-checked.

## Known pane limitation
- Custom-width `resize_window` breaks `navigate`; presets only. True 1280–1440 captures for the finish: try resizing *after* navigation, screenshot, then reset before the next navigate.
