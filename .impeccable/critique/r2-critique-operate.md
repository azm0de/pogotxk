# Round 2 critique — operate surfaces (Assessment A)

Run 2026-09-03 against the shipped Trail-Map Kiosk world. Targets: `/` + chrome, `/map`, `/go`, `/live`. Inspected at 375×812, 900×760, 1440×900, both schemes. Protomaps tiles failed in the dev server (env fault; exposed P2-6).

## Verdict
**Yes, the world is built — with one dissolving agent and one generic first move.** Unliftable: Overpass/Atkinson signage-over-reading-aid; the numbered `.post` with its ink disc; the 2px rule under every panel head; the map popup (type strip → photo → name → drawn-arrow Directions) — the best-composed object on the site; six drawn flare glyphs sharing the marker silhouettes. Pulling back: (a) **red is the link colour** (`global.css` reset `a { color: var(--accent) }`; 21 of 35 non-header links on `/` are red) so the Rationed Red rule is broken by the base sheet; (b) **the first move is a hero photo over a map** — the poster's composition with the art swapped.

## Heuristics — 26/40
1 Status 2 (tapping a `/map` row shows nothing; failed tiles silent; LIVE over an empty board) · 2 Real world 3 ("Legend" labels search+filters; "Pick the spot by hand" as a subtitle; `Street A, Texarkana, TX, USA` machine string) · 3 Control 3 · 4 Consistency 2 (disc carries four meanings; chips invert to ink in DESIGN.md but POI hues on `/map`; Unicode `▾ ↗ ● ★` beside drawn arrows; flare kinds drawn on `/go`, text on `/live`) · 5 Error prevention 3 · 6 Recognition 2 · 7 Flexibility 3 (29 tab stops to home's first CTA) · 8 Minimalist 2 (first viewport with no words; red 21×; 6,142px home) · 9 Recovery 3 (locate error 700px from the button, wearing the here-disc) · 10 Help 3.

## Cognitive load — 4 of 8 fail, three of them inside the `/map` panel.
Hierarchy: the display face is bound to *position* not *meaning* — post 1's loudest line is the date, event name is body; every "Happening now" card headlines a date range.

## Emotional journey
Arrival peak (GO Fest photo) → immediate valley (500px of map, not one word; the panel is always just below the fold: y=898 at 1440×900, y=837 at 900×760) → true peak (the panel) → the middle post usually says "Nothing burning right now" → `/map` valley (panel covers 78–89% of the phone, tap does nothing) → `/go` ends on "Nothing active right now." with no exit → `/live` ends on legal text. Home's end holds.

## Must not regress
The map popup (`MapView.tsx:130-260`); signed-out `/go` tiles as live links (`QuickActions.tsx:928-938`); the nav's current chip (static disc); `.post` + `.disc` + the ink rule; honest status copy; the credit ramp and the pin motif.

## P1
1. **The first viewport delivers the composition, not the content** — `index.astro:347-411`, `:959-976` (`.board-map` 70dvh → 560px ≥768), `:1023-1026` (overlap 64px). Board = banner 245–292 + map 560 + panel 300–538 − 64 = **1,088–1,330px** on a 760–900px screen; at 375×812 only the head peeks in. 0/4 of the contract's promise above the fold. Fix: banner `max-height` ~180/220px; `.board-map { height: clamp(240px, 42dvh, 380px) }`; larger overlap; demote the panel head (h1 + rule + two-line lede spend ~180px restating the map). Target: post 1 and "Open the map" visible at 375×812 unscrolled.
2. **Red is the link colour** — `global.css:463` `a { color: var(--accent) }`. Fix: ink default with an ink underline; `--accent` reserved for in-prose links, `.btn--primary`, and genuinely-now affordances. Add to DESIGN.md's Don'ts.
3. **Choosing a place on `/map` does nothing visible** — `MapView.tsx:541-566` `focusPoi` never closes the panel (721 of 812px); no selected state on `.poi-row`. Fix: `setPanelOpen(false)` below 768; `selectedSlug` → `.poi-row[aria-current]` ink-invert; on desktop offset the map centre by half the panel width.
4. **The home preview owns 24 of 63 tab stops** — `index.astro:387-388` mounts `<MapPreview compact />`; `MapView.tsx:881-884` says compact is "a picture", but markers are built without it (`:646`, `:772`) and Leaflet defaults `keyboard: true`. First CTA is tab stop 30. Fix: `{ keyboard: !compact, interactive: !compact }` on markers; drop the photo layer in compact.
5. **The legend keys three of six symbols** — `MapView.tsx:1156-1172`; on screen also ★ Campsite, the camera badge, the cluster disc, the live ring; home preview has no legend at all. Fix: add `★ Campsite spot`, `▣ Has a photo`, `③ tap to zoom in` rows (drawn, not glyphs); on home drop photo pins + clusters from the preview.

## P2
1. `Raid` and `Gym takedown` share the tower outline (`flareIcons.tsx:36-60`); change the *silhouette* (raid = tower in a burst; takedown = broken roofline / down chevron).
2. `/live` "LIVE" pill means socket-up (`LiveBoard.tsx:828-834`, `LiveBoard.css:74-80`), red + pulsing, 40px under the nav's red disc, over an empty board. Rename Connected / Reconnecting / Refreshing every 20s; ink dot; red only when `flares.length > 0`.
3. `/live` empty state holds two buttons inside the dashed box (`LiveBoard.tsx:1265-1276`) against DESIGN.md's rule; move the arrows into a solid panel.
4. `/map` panel label "Legend" + sr-only "and filters" (`MapView.tsx:1147-1149`); visible text `Legend & filters`, or split strip vs `Filter · 104 places` drawer.
5. Dates set as headlines, names as body — `index.astro:421-424` `.post-lead` on the time; "Happening now" cards. Swap: name `--text-xl` Overpass, date `--text-md` tabular ink; drop RUNNING under "Happening now".
6. A basemap that never loads looks like one still loading (`index.astro:1004` covers no-JS only). On first tile error after a grace period print one line in the map corner ("The park map isn't loading. The places are still listed below.") and on `/map` open the list.
7. Locate error renders ~700px from the button wearing the here-disc; anchor it beside the button with an ink mark.
8. Two Poké Balls in the mobile header (`Base.astro:113`, `:137`); give the toggle a drawn mark from this world (three stacked ink rules) and keep the word.

## P3
Unicode glyphs where the world says drawn (`MapView.tsx:1150` ▾, `:1209/:1264/:194` ★, `:161` ●, home ↗); cluster discs invert with the theme on a light-pinned basemap; `.count` carrying prose (`index.astro:532`, admitted at `:1142`) → a `.caption` primitive; home post 3 has no action; `/go` ends on "Nothing active right now." with no exit (`QuickActions.tsx:979`) and its inner scroll (`QuickActions.css:23`) hides ~135px with no cue; "Pick the spot by hand" as the h1's subtitle (`QuickActions.tsx:815`); `Street A, Texarkana, TX, USA` shown as the meetup's place; desktop `/map` wastes ~40% width and locate is marooned mid-map when the panel is shut — offset `fitBounds` for the panel, dock locate with zoom when shut; `/live` renders the Leek Duck attribution in the signed-out empty state (keep — the board fetches raids.json on load — but it makes the page end on legal text).

## Personas
Casey: first screen answers no question; `/map` panel 89%; 6,142px home; no persistent bottom action. Alex: 29 stops to the CTA; no clear-all filters; accelerators undiscoverable. Jordan: grey field with unlabelled discs; "Raid Route"/"Hotspot" undefined; "burning" metaphor never introduced; LIVE vs "Nothing on the board".

## Questions
1. If red is every link, every primary and the header — what is left for red to mean? Header ink with a red rule?
2. Which third of the board would you cut to fit 812px? (Half the banner, a third of the map.)
3. Should the board's second key be a standing invitation ("Raise a flare when you're at a gym →") rather than an absence?
4. Is the legend a strip and the filters a drawer — should they ever have shared a disclosure?
5. Could a member pick Raid vs Gym takedown at night without reading the label?
6. What would the board panel look like built from the popup's grammar?
7. Nothing on `/` is sticky; the "board stays, panels move" signature is neither built nor felt. Build it or delete it from the contract.
