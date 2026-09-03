# Round 2 audit — public surfaces (measured)

Run 2026-09-03 against the shipped Trail-Map Kiosk world: 18 routes × 2 schemes, 375/390/430/768/1000/1280/1440, 125% + 150% root font. Contrast measured on rendered pages; on-image credits pixel-sampled with the scrim re-derived per scanline. Coverage limits: signed-in states source-verified only; basemap tiles 404 in dev; Tab traversal assessed statically this round.

## Health Score — 19/20 (Excellent)
Accessibility 4 · Performance 3 · Responsive 4 · Theming 4 · Implementation integrity 4.

**Integrity verdict: PASS, materially stronger than round 1.** Detector: 118 findings, 18 in public code, all documented exceptions (9 in the `noindex` config-error page `auth/login.ts`, 4 neutral shadow alphas, 2 `#000` mask stops above a comment saying so, 2 `Cascadia Mono` fallback, 1 `#fff` on a measured fill). Round 1's `side-tab` ×12 and `layout-transition` are zero. The "fixed bug not carried to its siblings" pattern is closed structurally: one `.credit` (`primitives.css:390-410`) now measures 12.70–16.02:1 on the same photographs that measured 2.50 / 3.21 / 4.10 / 5.34.

## Findings
**P2**
- `MapView.css:930-951` hand-copies `.chip` under a "match exactly" comment that is already false (missing `text-decoration: none`); unlayered, so the copy wins. → delete it now that Admin imports `primitives.css` (sent to W5-operate).
- `icon-512.png` 354KB, `icon-maskable-512.png` 326KB, `og-default.png` 270KB — unchanged since round 1. **Fixed by the coordinator 2026-09-03:** the 512 icons were actually 3,641×3,641; resized to 512 and re-encoded as palette PNGs; OG re-encoded.
- No font preload; woff2 requests start at 603ms after CSS parse (FCP 864ms). → preload Overpass + Atkinson roman in `Base.astro` (coordinator, after W5-operate releases the file).
- `.panel-handle` has `aria-expanded` but no `aria-controls` (sent to W5-operate).
- Home board: the attribution clears the panel by exactly 8px at 375/768/1000/1440 — the whole margin on a licence obligation. → derive from `--map-attrib-h` (sent to W5-operate).
- `auth/login.ts:41-47` seven raw hexes, two raw sizes, colour-only ok/no states — the config-error page. → declare an explicit design-system exclusion (coordinator).

**P3**
- 35 heading links 23px (passes 2.5.8 by the spacing exception, 54–111px) → 1px `padding-block` (sent to W5-read).
- Two flare vocabularies (`LiveBoard.tsx:867-873, 1092` words vs `/go` drawn icons) → `<FlareIcon>` into the board (in W5-operate's packet).
- `--z-skip-link` defined, literal 2000 used (`global.css:513`) — **fixed**.
- `DESIGN.md:180` credits CARTO Voyager; the basemap is Protomaps → documenter rerun.
- Blanket `0.01ms` animation kill retained as a backstop — verified defused (every animation has its own escape; the map loader has a non-animated alternative). No change.
- `/blog` lazy-loads the pinned first card (LCP) (sent to W5-read).
- `MapView.tsx:719-746` ResizeObserver reads layout then writes custom props onto an ancestor (sent to W5-operate: rAF + change guard).
- `basemap.ts` no `tileerror` handler; pmtiles failures are silent uncaught rejections (W5-operate attaches the handler in MapView.tsx).
- Eight `PROMOTE:` comments outstanding; `.btn--arrow-back` and `.count` are already promoted → delete the local copies (sent to W5-read).

## Patterns
1. Round 1's #1 pattern closed structurally by promoting fixes to primitives.
2. Remaining drift = manual-sync copies claiming equivalence (the one live case: MapView `.chip`).
3. Carry-over is now all performance.
4. Comments no longer drift from code; the one stale claim is in DESIGN.md (CARTO).
5. Tokens converged: 48 font sizes → 10 tokens; every public raw hex is `#fff` on a measured fill, a brand mark, or a shadow alpha.

## Positive (must not regress)
Zero contrast failures on 18 × 2; every round-1 P1 fixed and verifiable (credits 2.50 → 14.17; popup links 5.99 / 5.54; attribution 4.02 → 5.54 dark; map loader alternative; h1→h3 skip gone; every sub-24px target gone). Zero overflow at every width and at 125/150%. Motion: zero `will-change`, zero `backdrop-filter`, one layout transition (`.skip-link`), every keyframe has an escape. `/go` sheets are real dialogs; map pins are named; hydration is deliberate; Attribution unconditional on all six Leek Duck pages; every image carries dimensions and alt; no `outline: none`.

## Verified false positives
Header text and on-image credits "fail" only because the probe cannot sample gradients (computed 5.99–7.29 and 12.70–16.02 respectively); 40 markers are named by an `sr-only` child; `--poi-powerspot` raw under white is fine (4.87, aliased as its own badge).
