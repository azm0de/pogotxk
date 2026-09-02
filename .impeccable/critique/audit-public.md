# Impeccable audit — public surfaces

Run 2026-09-01 on branch `impeccable-redesign` against the dev server (:4321), 18 public routes, both colour schemes, 375/390/430px and 125%/150% root font. Contrast figures are **measured** on rendered pages (canvas-sampled photograph pixels under scrims, alpha resolved per scanline). Coverage limits: `/go` signed-in and `/live` with live flares were not rendered; the map showed bare canvas in dev.

## Audit Health Score — 15/20 (Good — address the weak dimensions)

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 3 | Press-photo credits 2.50:1 over their own photos on `/`; reduced-motion kill freezes the map's only loading signal |
| 2 | Performance | 3 | High discipline; one permanent `will-change`, two images without dimensions |
| 3 | Theming | 3 | Exemplary token system, dark mode near-clean; `--poi-gym` as text at 3.18:1 |
| 4 | Responsive | 3 | Zero horizontal overflow on 18 routes × 3 widths and at 125/150%; ~20 standalone links 15–20px tall |
| 5 | Implementation integrity | 3 | Product-specific and reasoned; `.btn` ×4 geometries; a fix landed on `/blog` never carried to siblings |

**Integrity verdict: PASS.** Every unusual decision carries a measured justification in source. The drift is real (four `.btn`s, a scrim fix applied once, a target-size fix on the wrong element) but it is drift, not slop.

## P1
- **Press-photo credit scrims fail over their own photographs** — `index.astro:1912-1922` `.photos span` (**2.50:1**, 14.8% of text area < 4.5 at 1280; 2.54 at 390), `index.astro:1003-1010` `.community-shot figcaption` (3.21:1), `about.astro:148-155` `.about-hero figcaption` (4.10:1). Two-stop `transparent → rgb(0 0 0/.72–.78)` on a 31–52px box with text at 11–23px from the top, so the scrim is at 20–35% where the glyphs sit. Identical to the bug recorded in `vault/Bugs Worth Remembering.md` and fixed on `/blog` (`blog/index.astro:738-745`, five stops + `text-shadow`, measured 4.50–19.38:1, 0% failing). A licensing exposure. Fix: one shared class with `/blog`'s ramp.
- **`--poi-gym` used as text** — `game.css:154-156` `.g-fact--boosted dd` **3.18:1** light (5.23 dark). `--poi-gym-badge` exists for this.
- **Leaflet's link colour leaks into map popups** — no `.leaflet-popup-content a` rule; `.popup-source a` renders `#0078a8` = **3.36:1** on the dark panel. The attribution fix at `MapView.css:876-883` was never carried to popups.
- **Map attribution link 4.02:1 in dark** — `MapView.css:881-883`, `--accent` on the 88% pill over the light canvas; pill text passes at 4.87.
- **Global reduced-motion kill freezes `.map-loading-ball`** — `global.css:330-339` × `MapView.css:58-69`; the only progress signal on `/map` becomes a still ball (`MapView.tsx:936` asserts this as acceptable). Also `header-elevate`/`nav-fade-start` (`Base.astro:560, 753`) jump to end state. WCAG 2.3.3 asks for an alternative, not removal.
- **Standalone links under 24px** — footer row 16px on every route (`Base.astro:453-459, :928`); `.card-links a` 19px (`index.astro:1743-1750` — the documented fix padded the `<p>`); `/privacy` + `/terms` ToC 19–20px (`legal.css:110-133`); `.post-card-tags a` 19px; `.photo-where a` **15px**; `← All news` 19px, `#pokéstops` 20px.

## P2
- `.popup-credit` repeats the failing scrim (`MapView.css:374-383`; 5.34:1 on the one photo sampled — passes by crop luck).
- `.mini-shiny` ✦ **1.81:1** light (`index.astro:1719-1725`); `--poi-campsite` has no `-badge` counterpart.
- `/map` heading hierarchy skips h1 → h3 (`MapView.tsx:1036`).
- `.btn` ×4 geometries: `index.astro:1431` (pill, 12/22, 700), `LiveBoard.css:158` (8px, 9/16, 600), `device.astro:292` (8px, 10/18, min-h 44), `error.astro:72` (8px, 10/18).
- `/events` hand-rolls the Leek Duck credit inside a data conditional (`events.astro:107, 220-238`) instead of `<Attribution />`.
- Images without dimensions: `/about` hero (`about.astro:39-43`, eager), Discord avatar on `/`.
- Sub-11px text at volume: `.mini-tier` 9.6px ×12, `.post-row-pin` 9.6px, `.g-reward-cp` 10.9px ×196, `.event-badge` 10.6px ×60, `.photo-credit` 10.9px ×9, `.poi-row-tag` 10.6px.
- `will-change: transform` never released — `index.astro:1026-1027, 1046-1049` on a 32s infinite scale of a 1060×309 photo; retained under reduced motion.

## P3
Hover transforms not cancelled under reduced motion (`Base.astro:662, 879`, `MapView.css:117`); `userPos` in marker-rebuild deps closes open popups on locate (`MapView.tsx:698`); O(n²) slug lookup in the flare-reflect loop (`MapView.tsx:707`); `icon-512.png` 354KB / maskable 326KB / `og-default.png` 270KB; `#8257d9` hardcoded with a stale rationale (`EventCard.css:75-92`); stale scrim comment (`events.astro:306-311`); `LiveBoard.css` exports bare `.btn/.form-actions/.form-grid/.live`; `BubbleControl` `client:load` renders nothing outside the app (`go.astro:42`); `backdrop-filter: blur(16px)` recomposites while the map pans (`MapView.css:575-576`); flare cards have two vocabularies across `/live` and `/go`; 48 distinct `font-size` values across 42 files, 30 below 1rem.

## Patterns
1. **A fixed bug not carried to its siblings, three times** (scrim ×4 copies; Leaflet link specificity; target-size wrapper). Measured proof: `/blog` 4.50–19.38:1 with 0% failing vs `/` 2.50:1 with 14.8% failing, same photographs.
2. Two-token pairs are the main colour hazard and the wrong half keeps being reached for; `--poi-campsite` has no badge counterpart.
3. Failures cluster in light mode (three light-only, one dark-only across 18 routes × 2 schemes).
4. Primitives re-implemented per surface: 4 `.btn`, 5 card systems, 7 badge/chip systems, 48 font sizes.
5. Comments drift from the CSS beneath them (`EventCard.css:75-92`, `events.astro:306-311`, `MapView.tsx:936`).

## Positive
- Key-art hero scrims genuinely hold: `/events` h1 5.90 / lede 5.60 at 1280, 8.08 / 7.44 at 390; `/raids` 6.29 / 6.07; `/blog` 6.02 / 5.54 / RSS 6.50 — zero pixels below 4.5.
- The 169px overflow bug stays closed: 18 routes × 375/390/430, 125/150% font, and a synthetic 2201px table on a post scrolls inside a 328px box.
- Keyboard path correct end to end: 24 stops on `/`, skip link first, visible ring on every stop, zero rings clipped, no `outline: none` anywhere.
- Filter panel `aria-expanded` and computed display agree; marker icons mutate in place so popups survive the 60s refresh.
- Dark mode near-spotless; `--accent/--accent-solid` and `--live/--live-text` hold under measurement.
- Performance discipline: one layout-property transition (`skip-link`), `preload="none"` + poster + `saveData` on the 656KB video, lazy/async below the fold, srcset on every hero, game pages server-rendered from KV.
- Header gradient holds the 0.9-white chips above 4.5:1 at every stop.

## Verified false positives (from this audit's own sweep and the detector)
Detector `side-tab` ×12 dismissed by the auditor as the documented colour-plus-word system — **note:** Assessment B disagrees for the eight undocumented callout boxes; both are recorded and the backlog keeps the callout consolidation. `em-dash-overuse` (comments, not copy). `.social--campfire` 3.98 (missed `opacity: .85`; true 7.97). Attribution *text* 1.99 (parser choked on `color(srgb …/.88)`; true 4.87). Popup close button (sibling, not child; 4.87). `a.brand` nameless (name comes from the logo `alt`).

## Appendix
```
P1 | a11y        | src/pages/index.astro:1912              | .photos span press credit 2.50:1 over photo
P1 | a11y        | src/pages/index.astro:1003              | .community-shot figcaption 3.21:1
P1 | a11y        | src/pages/about.astro:148               | .about-hero figcaption 4.10:1
P1 | theming     | src/components/game/game.css:154        | --poi-gym as text 3.18:1 → --poi-gym-badge
P1 | a11y        | src/components/map/MapView.css:455      | popup links inherit Leaflet #0078a8 = 3.36:1 dark
P1 | a11y        | src/components/map/MapView.css:881      | attribution link 4.02:1 dark
P1 | a11y        | src/styles/global.css:330               | reduced-motion kill freezes the map loader
P1 | responsive  | src/pages/index.astro:1743              | .card-links fix on the <p>, links stay 19px
P1 | responsive  | src/layouts/Base.astro:928              | footer links 16px on every route
P1 | responsive  | src/styles/legal.css:110                | legal ToC links 19-20px
P2 | a11y        | src/components/map/MapView.css:374      | .popup-credit two-stop scrim
P2 | a11y        | src/pages/index.astro:1719              | .mini-shiny 1.81:1; no --poi-campsite-badge
P2 | a11y        | src/components/map/MapView.tsx:1036     | h1 → h3 skip
P2 | integrity   | src/pages/index.astro:1431              | .btn ×4 geometries
P2 | integrity   | src/pages/events.astro:220              | hand-rolled credit inside a conditional
P2 | perf        | src/pages/about.astro:39                | hero img no dimensions; Discord avatar likewise
P2 | responsive  | src/pages/index.astro:1719              | sub-11px text at volume
P2 | perf        | src/pages/index.astro:1027              | will-change never released
P3 | a11y        | src/layouts/Base.astro:662              | hover transforms under reduced motion
P3 | perf        | src/components/map/MapView.tsx:698      | userPos in rebuild deps
P3 | perf        | src/components/map/MapView.tsx:707      | O(n²) slug lookup
P3 | perf        | public/icons/icon-512.png               | oversized install/OG assets
P3 | theming     | src/components/events/EventCard.css:88  | #8257d9 hardcoded, stale rationale
P3 | integrity   | src/pages/events.astro:306              | stale scrim comment
P3 | integrity   | src/components/live/LiveBoard.css:158   | unnamespaced globals
P3 | perf        | src/pages/go.astro:42                   | BubbleControl client:load
P3 | perf        | src/components/map/MapView.css:575      | backdrop-filter over a panning map
P3 | integrity   | src/components/go/QuickActions.css:199  | two flare vocabularies
P3 | integrity   | repo-wide                               | 48 font sizes
```
