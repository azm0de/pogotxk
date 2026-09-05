# Impeccable audit — admin surfaces (source-only)

Run 2026-09-01 on branch `impeccable-redesign`. **Source-only**: no browser (admin needs Discord sign-in). Contrast figures are calculated from `global.css` token values, not measured on a render. Admin was out of scope for the first round of the 2026-09 redesign; the second round brought it in as **W4**, and these findings became its brief.

> **Status 2026-09-05 — closed.** W4 (`b976fe0`, the admin editors into the kiosk world) and the round-two promotions (`f026d90`) took every finding below. Verified against the code on 2026-09-05:
> - **P0**: lat/lng `<input type="number" step="0.0000001">` beside the drag (`MapEditor.tsx:626-640`); the attribution sheet takes focus on open, wraps Tab, closes on Escape and restores focus to the opener (`MediaLibrary.tsx:179-199`).
> - **P1**: no raw `--poi-gym` / `--poi-campsite` / `--accent` fill or small text remains in `src/components/admin/*.css` (the two `--accent` uses left are a drop-shadow and a focus outline); both islands carry an `<h1>`; `min-width: 0` sits on the ellipsis and preview children.
> - **P2**: a dragged pin updates in place and selection highlights without a rebuild (`MapEditor.tsx:235-316`); the remove-tag button is 24×24 (`PostEditor.css:132`); pane-switch buttons are 28px tall (`PostEditor.css:201`); the map container is named "POI map" (`MapEditor.tsx:490`); the import bar scales on X instead of animating `width` (`ImportPanel.css:79-87`).
> - **P3**: `Admin.astro` imports `primitives.css`; the four `.btn` copies, the two swapped list-row grids and the three status-pill vocabularies are gone, leaving only contextual overrides (`.editor-toolbar .btn`, `.import-done .btn`).
>
> Still owed, and not a code task: a real-session pass over the editors — PATCH on drag and on the lat/lng inputs, a media upload, the markdown preview on real posts — with Justin's Discord session. The score below is the pre-W4 measurement, kept as the record.

## Audit Health Score — 11/20 (Acceptable — significant work needed)

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 2 | POI repositioning is drag-only — no keyboard path |
| 2 | Performance | 3 | One dragged pin rebuilds every marker (`MapEditor.tsx:195-238`, effect keyed on `visible`) |
| 3 | Responsive | 2 | Two `min-width: 0` omissions on truncating/scrolling grid children |
| 4 | Theming | 2 | Four raw `--poi-gym` / `--accent` misuses that `global.css` comments already name |
| 5 | Implementation integrity | 2 | `.btn` ×4, status pill ×3, list-row grid ×2 reimplemented |

Verdict: pass with real drift — product-specific throughout, but the CSS layer has drifted from itself.

## Findings

### P0
- **POI repositioning has no non-pointer method** — `src/components/admin/MapEditor.tsx:515-518` (coords rendered as text), drag handler 220-233. WCAG 2.1.1. Fix: editable lat/lng `<input type="number" step="0.0000001">` wired through `set()`; keep drag as convenience.
- **Attribution modal has no focus management** — `src/components/admin/MediaLibrary.tsx:246-353` (`role="dialog" aria-modal="true"`, zero `focus()`/`Escape`/trap). WCAG 2.4.3, ARIA dialog pattern. Fix: focus in on open, trap Tab, Escape closes, restore focus to the tile.

### P1
- **`--accent` as a filled surface with `#fff` text** — `PostEditor.css:64-71` `.posts-toast--ok`. ~3.0:1 in dark mode. Siblings (`MapEditor.css:165`, `MeetupEditor.css:47`) use `--accent-solid` correctly. Fix: `--accent-solid`.
- **Raw `--poi-gym` as a white-text badge fill (×3)** — `MapEditor.css:91-99` `.editor-status`, `MapEditor.css:137-141` `.tool-btn.is-on`, `MediaLibrary.css:51-62` `.media-count`. 3.18:1. Fix: `--poi-gym-badge` (4.62:1), as `MapView.css:814` already does.
- **Raw `--poi-gym` / `--poi-campsite` as small text** — `MapEditor.css:47-52` `.editor-drafts`, `MediaLibrary.css:143-146` `.media-flag--warn`, `MapEditor.css:88-90` `.editor-star`, `PostEditor.css:435-437` `.post-row-pin`. 3.18:1 and ~2.08:1 on the light panel. WCAG 1.4.3 / 1.4.11.
- **No page-level `<h1>`** on `MapEditor.tsx` and `MediaLibrary.tsx` (the only heading in MediaLibrary is inside the dialog). WCAG 1.3.1 / 2.4.6.
- **`min-width: 0` missing** — `MapEditor.css:82-87` `.editor-item-name` (flex child with ellipsis), `PostEditor.css:304` `.body-preview` (1fr grid track holding `pre { overflow-x: auto }`). The 169px-overflow bug class.

### P2
- One dragged pin rebuilds every marker — `MapEditor.tsx:195-238`, deps `[visible, notify]`; update the single marker in place.
- Remove-tag button 17×17px — `PostEditor.css:200-213`; floor is 24px.
- Pane-switch buttons ≈22-23px tall — `PostEditor.css:272-281`.
- Leaflet container has no accessible name — `MapEditor.tsx:394`; add `aria-label="POI map"`.
- Progress bar animates `width` — `ImportPanel.css:73-78` (detector `layout-transition`); use `transform: scaleX()`.

### P3
- Four `.btn` implementations — `MapEditor.css:316`, `MeetupEditor.css:125`, `PostEditor.css:35` (`.posts .btn`), `ImportPanel.css:127` (`.import-panel .btn`). `PostEditor.css`'s header comment says the duplication is deliberate to avoid island-bundle collisions.
- Two list-row grids with swapped columns — `MeetupEditor.css:158` (`190px 1fr auto auto`) vs `PostEditor.css:414` (`1fr 190px auto auto`).
- Three status-pill vocabularies — `.editor-status`, `.meetup-status--*`, `.post-state--*`.

## Patterns
1. The design system's own documented fixes are bypassed, not unknown: every theming miss has a named token (`--accent-solid`, `--poi-gym-badge`) that the comment beside it recommends. Sweep `src/components/admin` for `var(--accent)` / `var(--poi-*)` (not `-badge`/`-solid`) next to `#fff`.
2. `min-width: 0` omissions recur; grep `text-overflow: ellipsis` and `overflow-x: auto` inside flex/grid containers.
3. Micro-component vocabularies are reimplemented per island; `MapEditor.tsx` proves reuse works (it rides `MapView.css`'s `.chip`).
4. The two surfaces with custom interaction models (drag map, modal) are exactly where keyboard/focus gaps live.

## Positive
- `--accent-solid` used correctly in three of four toast sites; `--poi-campsite` + `#4a2c00` badge pattern reused verbatim (~6.1:1).
- Blanket reduced-motion rule transitively covers every admin transition.
- Markdown preview is XSS-safe by construction and uses `useDeferredValue`.
- `Admin.astro` nav is hand-audited against real routes (documented regression guard); dashboard distinguishes linked cards from static ones.

## Recommended actions (later pass) — all taken in W4, see the status note above
1. P0 `/impeccable harden` — lat/lng inputs; dialog focus management.
2. P1 `/impeccable harden` — the token swaps; `<h1>`s; `min-width: 0` ×2.
3. P2 `/impeccable harden` — target sizes; map `aria-label`. `/impeccable optimize` — marker rebuild; progress bar transform.
4. P3 `/impeccable distill` — shared admin primitives (could import `src/styles/primitives.css` once it exists).

## Appendix
```
P0 | a11y        | src/components/admin/MapEditor.tsx:515    | POI position drag-only, no keyboard path
P0 | a11y        | src/components/admin/MediaLibrary.tsx:246 | dialog has no focus management
P1 | theming     | src/components/admin/PostEditor.css:70    | --accent fill + #fff (3.0:1 dark)
P1 | theming     | src/components/admin/MapEditor.css:97     | --poi-gym fill + white (3.18:1) → --poi-gym-badge
P1 | theming     | src/components/admin/MapEditor.css:138    | --poi-gym fill + white → --poi-gym-badge
P1 | theming     | src/components/admin/MediaLibrary.css:58  | --poi-gym fill + white → --poi-gym-badge
P1 | a11y        | src/components/admin/MapEditor.css:50     | --poi-gym as 11px text
P1 | a11y        | src/components/admin/MediaLibrary.css:145 | --poi-gym as 10.5px text
P1 | a11y        | src/components/admin/MapEditor.css:89     | --poi-campsite icon ~2.08:1
P1 | a11y        | src/components/admin/PostEditor.css:436   | --poi-campsite icon ~2.08:1
P1 | a11y        | src/components/admin/MapEditor.tsx        | no <h1>
P1 | a11y        | src/components/admin/MediaLibrary.tsx     | no <h1>
P1 | responsive  | src/components/admin/MapEditor.css:82     | min-width:0 missing on ellipsis flex child
P1 | responsive  | src/components/admin/PostEditor.css:304   | min-width:0 missing on 1fr preview pane
P2 | perf        | src/components/admin/MapEditor.tsx:238    | full marker rebuild on single drag
P2 | responsive  | src/components/admin/PostEditor.css:203   | 17px remove-tag button
P2 | responsive  | src/components/admin/PostEditor.css:272   | ~22px pane-switch buttons
P2 | a11y        | src/components/admin/MapEditor.tsx:394    | map container unnamed
P2 | perf        | src/components/admin/ImportPanel.css:77   | transition: width
P3 | integrity   | src/components/admin/*.css                | .btn ×4, status pill ×3, list row ×2
```
