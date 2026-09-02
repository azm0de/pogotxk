# Critique — `/map`, `/go`, `/live` (Assessment A, design review)

Run 2026-09-01, branch `impeccable-redesign`. Mode: Operate. Inspected mobile-first in both schemes; signed-out states live, signed-in states from source. Isolated from detector output.

## Design-specificity verdict

**Grounded on `/map`, category-interchangeable on `/go` and `/live`.**

`/map` could not be lifted into another product: original marker SVGs with distinct silhouettes *and* hues (`markerIcons.ts:23-31` — diamond, tower, hexagon); the popup drops the imported `Campsite - ` prefix (`MapView.tsx:376-385`); the basemap refuses dark mode because a map is content (`MapView.tsx:500-528`). Pulling it back toward stock Leaflet: default circle-with-a-number clusters restyled red (`MapView.tsx:549-554`) — and red is now the brand *and* the live signal, so three PokéStops carry more urgency than an active raid; a generic 104-row result list; nine black camera chips permanently over the functional layer.

`/go`'s entire icon system is platform emoji (`QuickActions.tsx:27-32`: 🔥📣⚔️👋🤝🙋). Swap six emoji and six labels and it is any app's action grid; the Poké Ball mark and the marker vocabulary appear nowhere on the PWA start URL. `/live`'s empty state is two dashed cards of identical weight; "Nothing burning right now" is the only authored thing on it. **The product's own pin silhouettes are a ready-made icon language for flare kinds, and both flare surfaces ignore it.**

## Heuristics — 73/120 = 61% (Acceptable)

| # | Heuristic | /map | /go | /live | Note |
|---|---|---|---|---|---|
| 1 | Status | 2 | 2 | 4 | `/live`'s connection pill names degradation; `/map`'s locate is silent |
| 2 | Real world | 4 | 3 | 4 | `/go` renames three of six kinds |
| 3 | Control | 3 | 2 | 2 | No Escape on any sheet; no clear-all filters |
| 4 | Consistency | 2 | 1 | 2 | Two flare-raising UIs, two label sets, three sign-in treatments |
| 5 | Error prevention | 3 | 3 | 3 | `loadPrefs` refuses an all-hidden map (`MapView.tsx:46-48`) |
| 6 | Recognition | 2 | 3 | 2 | No legend anywhere; cluster numbers unexplained |
| 7 | Flexibility | 3 | 1 | 1 | Deep links + persisted prefs on map; no keyboard path on flare surfaces |
| 8 | Minimalist | 2 | 2 | 2 | Occlusion, twin voids, twin identical cards |
| 9 | Error recovery | 2 | 3 | 4 | Blocked-notifications copy exemplary; geolocation failure invisible |
| 10 | Help | 1 | 3 | 2 | `/go`'s intro card is real help; `/map` has none |

## Cognitive load
`/map` HIGH (4 of 8 fail): three systems in one 375×812 frame; 104 flat rows in a 210px window (`MapView.css:745-747`), ~5 visible, two "Boy Scouts of America" rows distinguished only by a dot; red clusters, black camera chips and orange badges at equal weight; drawer presents 6 chips + search + 104 rows at once. `/go` MODERATE: six tiles of identical weight, no primary, loudest element a blurple sign-in pill; six options at one decision point. `/live` LOW: sign-in prompt and empty state are the same dashed card.

## Emotional journey
Peak: the POI popup (photo, badge, name, distance, Directions, Copy link). Second peak: "Live updates unavailable — refreshing every 20 seconds" (`LiveBoard.tsx:709`) — truth over polish shipped. Valleys at the *start* of tasks: "Show my location" produces nothing visible — status only reaches the sr-only region (`MapView.tsx:1071-1072`), so "Nearest gym: X, 240 m away" is a feature almost nobody sees; `/go` signed out — all six tiles `disabled` (`QuickActions.tsx:846`), a tap does nothing. End: `/live` empty says "nothing", a void, then the trademark notice.

## What's working
1. Marker silhouettes carry meaning independent of colour (`markerIcons.ts:23-31`, `:73-96`).
2. The connection pill (`LiveBoard.tsx:701-710, 723-728`) — dot *and* word, three named states.
3. Popup and filter craft: on-image credit with scrim (`MapView.css:374-383`); prefs persist; filled type badge vs outlined attribute badges; search filters list, markers and announced count together.

## Priority issues

### `/map`
- **[P1] OSM credit structurally occluded by the filter drawer at 375px** — `MapView.css:940-956` panel `right:52px; bottom:8px` (y 262–804) vs attribution at x 157–376, y 794–813; open and closed. Renders "…eetMap © Protomaps", bottom pixel row clipped, 10.56px. Licensing. Fix: credit in the panel handle row, or lift it above the panel; do not shrink the panel. → layout
- **[P2] Locate button placed out of thumb reach and reports nothing** — `MapView.css:963-967` moves it to `top:12px; right:12px` at ≤640px; `locate()` (`MapView.tsx:878-908`) writes to sr-only only. Fix: bottom-left mirroring the zoom stack; busy state; visible transient status pill. → clarify
- **[P2] Nine community photo pins above the functional layer, unfilterable** — `MapView.tsx:561-591`, outside cluster and filters; cover cluster counts; survive search. Fix: a fourth toggle chip; drop on active search. → distill
- **[P2] No legend; list rows differ by colour alone** — `MapView.tsx:1051`. Fix: type word per row; persistent 3-item legend on the handle. → clarify
- **[P3] Clusters announce as a bare number; no `invalidateSize()` on resize** — `MapView.tsx:549-554`. → harden

### `/go`
- **[P1] Six disabled tiles swallow the tap signed out** — `QuickActions.tsx:846`. Fix: keep tiles live → `/auth/login?next=/go&action=raid`. → clarify
- **[P1] Three sign-in affordances, three treatments** — header ghost pill, `QuickActions.css:76` `#5865f2` filled pill (the one raw hex; most saturated non-red element under a scarlet header), red inline link. Fix: one sign-in, in the gate, tokenised. → quieter
- **[P1] `/go` and `/live` are two products for the same six actions** — grid+sheet vs inline form (`LiveBoard.tsx:737-830`); labels diverge (`QuickActions.tsx:28-30` Invites / Takedown / I'm here vs `src/lib/db/flares.ts:30-32` Remote invites / Gym takedown / Meet me here). Fix: one label source, one compose component. → adapt
- **[P2] No primary tile; emoji are the icon system** — `QuickActions.tsx:27-32`. Fix: Raid full-width; flat SVGs in the marker vocabulary. → bolder
- **[P2] Two ~200px voids sandwich a marketing card** — `.go-board` y 131→538 holding a 195px intro. Fix: raise the grid, two-line lede, gate directly above tiles. → layout

### `/live`
- **[P1] Empty state offers no next step** — `LiveBoard.tsx:881-884`. Fix: "See the park map" + next meetup with date + push toggle. → onboard
- **[P1] Sign-in prompt and empty state are the same card** — `LiveBoard.css:96-97`. Fix: gate = solid card with a real button; empty = quiet dashed panel. → shape
- **[P2] `.empty-art-bg` pins land on the sentence at 375px** — `global.css:463-469` intent holds at 800px, fails when copy wraps. Fix: clamp mask to top-right or drop below 480px. → polish
- **[P2] `/go` sheets declare `aria-modal` with no focus management** — `QuickActions.tsx:856-864`, `:952-960`; zero `keydown`, zero `focus()`. → harden
- **[P3] `.go-gate` border is `#f2a33c`, the Campsite POI colour** → colorize

## Persona red flags
- Casey: locate silent and top-corner; drawer covers 542 of 812px so she cannot see the map change; 104 rows five at a time; the 🔥 Raid tile is dead; sheet state is component-local so a game interruption loses her boss and note; chips 33px vs tiles 76px.
- Alex: no shortcuts; no Escape anywhere (zero `keydown` handlers across all three components); nothing learned on `/go` transfers to `/live`; no kind filter on `/live`; deep links exist but are never surfaced; six equal tiles when the answer is "raid" 80% of the time.
- Sam: clusters "7, button"; `aria-modal="true"` without management is worse than no dialog role; disabled tiles removed from tab order; `role="application"` on the canvas (`MapView.tsx:928`) with an unannounced list escape hatch. Correct: sr-only marker labels, `hidden` panel body really `display:none`, sr-only `<h1>`, live region.

## Minor
`QuickActions.tsx:696` "Active flares" landmark holds the pitch signed out; 17 bare `<datalist>` generics leak into the a11y tree (`:940-948`); "Location off — pick manually" reads as an error with no retry; attribution renders "© ©"; Leaflet link's name is its `title`; `MapView.css:162` `#4a2c00` and `:220` `#3b2200` raw hexes; the header wordmark is the Pokémon GO logotype lockup beside a rule that says the logo is not used — the constraint and the asset contradict in writing; `/live` desktop crops Moltres against the viewport edge; no styled search clear.

## Questions
1. If `/go` is the PWA start URL and the bubble target, why does it open with a pitch instead of the six tiles?
2. What if `/map` and `/go` were the same screen? The popup already has "Flare this".
3. You drew three marker silhouettes that survive greyscale. Why do the flares use system emoji?
4. Clusters are red, live is red, the brand is red. Should a cluster be a number at all, or the silhouettes it contains?
5. What is the confident version of `/live` when nothing is happening?
6. Does the 104-row list belong in the drawer? Sort by distance and give it its own screen?
7. Why does "where am I" sit in the top corner and report only to screen readers? What if it were the largest button, bottom-centre, with the nearest gym as a card?
