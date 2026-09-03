# Wave rules — every build agent reads this first

You are building one wave of the PoGo TXK redesign into the **trail-map kiosk** world. Read, in this order, before touching a file:

1. `PRODUCT.md` — product truth.
2. `.impeccable/surfaces/src-pages-index-astro.md` — the direction contract, signature interaction, cross-surface reach.
3. `.claude/skills/pogotxk-design/SKILL.md` — licences and the accessibility floor. It outranks everything below.
4. `C:\Users\Justin\.claude\skills\impeccable\reference\craft-floor.md` — the quality floor and the refusals.
5. `src/styles/global.css` (tokens) and `src/styles/primitives.css` (the shared vocabulary). Use them; do not redefine them.
6. `.impeccable/critique/backlog.md` — your files' findings are your acceptance criteria.

## The world, concretely

The site is the park's wayfinding board. The map is the ground; everything else is a **panel** bolted over it. White panels (`.panel`) on the basemap's warm grey or the page ground; a black rule under each panel head; Poké Ball red **only** for here / now / active (`.here`, `.disc--live`, `.badge--live`, the primary button, the current nav item). Signage type: headings, numerals, labels and running heads in `var(--font-sign)` (Overpass) at weight 700–800; body and UI in `var(--font-read)` (Atkinson Hyperlegible Next). Set `font-family: var(--font-read)` on your page's root wrapper and `var(--font-sign)` on headings/labels; do not touch the global `body` or `h1–h4` rules. Numerals that are data get `font-variant-numeric: tabular-nums`. Every action points somewhere: `.btn--arrow`. Counts are black-ringed white discs (`.disc`). Numbered posts (`.post` + `.disc`) only where the number is a key (a legend, a route step, a tier's star count) — never as decoration.

Light is the default scene (outdoors, daylight); dark mode is the same board at night: same layout, ink inverted, the basemap stays light.

**Retire, in your files:** key-art banner heroes; the stat-row hero; eyebrows/kickers above headings (a ban — the heading carries its own weight; a document's class and date go *below* the H1 as a plain line); coloured `border-left` callouts above 1px (use a quiet `.panel` or `.empty-state`); emoji as icons (author flat SVG in one stroke weight, or reuse the marker silhouettes in `src/components/map/markerIcons.ts`); `--poi-*` colours off the map (game pages and callouts get ink, the red, or `--poi-*-badge` only where white text sits on it); Pokémon watermark art on your surfaces (the `.art-band` pieces belong to the old world; leave the utility in global.css, stop using it).

## Rules (verbatim, non-negotiable)

1. **Wave-complete migration.** Every file you own ends with zero raw `font-size` in rem/px/em, zero raw `z-index` integers, zero hand-rolled gutter `clamp()`s, zero raw hex colours. A raw value survives only with a one-line justification comment beside it. Gate before you report: `grep -nE "font-size:[^;]*(rem|px|em)|z-index:\s*-?[0-9]|#[0-9a-fA-F]{3,8}\b" <your files>` — every hit has a comment.
2. **Nobody edits `primitives.css` or `global.css`.** A missing primitive is written locally in your own file with a `/* PROMOTE: <name> — why */` comment.
3. **The scoped-style trap.** Astro compiles `.btn` → `.btn[data-astro-cid-x]`; a scoped `.btn` in your page beats the primitive. Delete the local copy and use the primitive class in markup. To adjust a primitive from a page, set its custom property on a scoped wrapper (`--btn-pad-inline`, `--card-pad`, `--panel-pad`, `--prose-measure`) rather than `:global(.btn)`. React islands have no scoping: they get the primitive as written.
4. **`--accent` inverts in dark mode.** A filled surface with white text uses `--accent-solid`, `--live`, `--discord`, or a `--poi-*-badge`. Never `background: var(--accent)` with `#fff`.
5. **Never `sed -i` / `perl -i` on any file.** Use the Edit tool. If you bulk-write, restart nothing — the dev server is already running at http://localhost:4321 (Vite HMR); do not start another.
6. **Class-name contracts.** Keep `.event-card .event-image .event-title .event-blurb .event-actions` (W1-B) and `.g-attribution` (W1-C) — the home page styles them via `:global`. Do not rename them; rewrite their internals freely.
7. **Home section order is the owner's.** Not changed in markup and not via `order:` / `grid-area:` (W1-A: see your packet for the two moves the owner approved).
8. **Only your files.** Your ownership list is exclusive. If you need a change in a file you do not own, write it as a one-line request in your report.
9. **Licensing.** `Attribution.astro` renders outside every empty-state conditional on pages carrying Leek Duck data; every Leek Duck image goes through `proxiedImageUrl()` (`src/lib/game-image.ts`); press-photo credits ride on the image via `.figure` + `.credit`; the OSM/Protomaps attribution control is never covered; no Pokémon GO logo.
10. **Accessibility floor.** 4.5:1 for text in both themes (measure computed values, do not read the CSS); 24px standalone targets (`.target` for links in running text); `[hidden]` now really hides; every animation uses `var(--lift)` / `var(--press)` or has its own reduced-motion escape; colour never the only signal (a word or a shape beside every hue); visible focus (never `outline: none`); `min-width: 0` on flex/grid children holding long text, tables or scroll regions; Astro trims trailing whitespace before an element on the next line — use `{' '}`.
11. **Copy.** Plain verbs, the product's own words, no em-dashes in new body copy. Controls name their action. Errors name the problem and the recovery.
12. **Do not commit.** Report the files you changed.

## Verify before you report (in the Browser pane, your OWN tab via `tabs_create`; pass its tabId on every call)

- `resize_window` with **preset only** (`mobile` / `desktop`) plus `colorScheme` — a custom width breaks navigation in this pane. Reset to `desktop` when done.
- Every owned route: light and dark, mobile and desktop; scroll the whole page; screenshot for your own judgement.
- Overflow probe via `javascript_tool`: `document.documentElement.scrollWidth <= window.innerWidth` on every owned route at mobile.
- Contrast probe via `javascript_tool`: walk visible text nodes, resolve the effective background, compute the WCAG ratio, list every pairing under 4.5 with its selector — both schemes. Fix them.
- Keyboard: Tab through once; the ring is visible on every stop; nothing hidden receives focus.
- Reduced motion: emulate it (`matchMedia` cannot be forced from JS; read your CSS instead and confirm every transform goes through `--lift`/`--press` or has an escape).
- `node C:/Users/Justin/.claude/skills/impeccable/scripts/detect.mjs <your files>` — zero non-advisory findings, or each justified.
- `npm run typecheck` if you touched a `.ts`/`.tsx`.

## Report format

1. Files changed (paths).
2. Backlog items closed (quote the location), and any you could not close, with why.
3. Measurements: worst contrast pairing per route per scheme; overflow probe results; target sizes you changed.
4. `PROMOTE:` requests and cross-file requests.
5. Honest risks: anything the reviewer should look at first.
