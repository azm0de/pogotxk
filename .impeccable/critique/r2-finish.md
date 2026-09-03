# Round 2 finish review — record (2026-09-03)

Reviewer: `impeccable-finish-reviewer`, fresh context, packets `.impeccable/review/packet.md` + `packet-r2.md`. Code-led; no comp, no QUALITY BAR board; the bar was the direction contract + the craft floor + the licence/a11y skill.

## Sequence
1. **recapture** — two `/map` files invalid (stale pre-round-2 locate shot in the wrong scheme; a 390 capture showing protomaps' flat pre-paint). Regenerated with a 7s settle and geolocation denied; in headless Chrome the pmtiles range request fails, so `/map` captures show the designed watchdog state (line + auto-opened legend), which the reviewer accepted as judgeable.
2. **fix** — eight material items: map credit links red; `.prose` link carve-out; `.btn--ghost` on wayfinding links; 5★ panel mostly empty at 1440; "Happening now" spent on a calendar; two words for one live state; ~100 unclustered preview pins; an undocumented filled disc. Applied in `e9b718a`.
3. **verdict pass 1** — 7 resolved, 1 partial (fix 6: DESIGN.md still said "Happening now"; badge unverified by capture), 2 regressions (5★ card stretched to 1,076px; "In game today" / "In the game this week" collision). Applied in `4d1b11f`.
4. **verdict pass 2** — fix 6 resolved, heading resolved, 5★ card **partial**: the 320px cap resolved to three columns at 1440, restoring the empty panel and wrapping the four-boss 1★ row. The reviewer's two-round budget ended here with disposition **fix** on that one grid rule plus a one-word heading.
5. **Beyond the budget (coordinator, self-verified):** `99c9ea8` — four columns at ≥1000px; a one-boss tier lays its card out as a sign (sprite in column 1, name/facts/badges stacked beside it, grouped left, spanning the panel). Measured at 1440: 5★ 1 card spanning 1,076px with art at x=199 and the name at x=351–542; Mega 3/row; 3★ 3/row; 1★ **4 on one row**; page 2,979 → 2,596px. At 390 single column, unchanged. `/events` group heading "Running now" → "In progress". Typecheck clean, detector 0.

## Standing limits (named, not blockers)
- The map popup has never been evidenced by a capture (needs a click); verified by W2-A in the pane during its wave.
- Signed-out `/go` tile `href`s confirmed by W2-C in the DOM, by the reviewer only by appearance.
- The basemap has never rendered on `/map` in a headless capture (pmtiles range fetch fails there; it renders in the pane and, per the vault, in production).
- Signed-in states (`/go` sheets, populated `/live`, delete success, device approval) and the admin editors' PATCH round-trips are fixture-verified only — need Justin's Discord session.

## Must-not-regress (confirmed surviving both passes)
The map popup composition; signed-out `/go` tiles as live links; the nav's current chip (static disc); `.post` + `.disc` + the ink rule; honest status copy; the credit ramp; the pin motif; the ink-plate warning badge; the home fold budget (post 1's RSVP and "Open the map" above 812px at 390).
