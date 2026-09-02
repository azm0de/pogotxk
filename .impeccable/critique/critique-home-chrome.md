# Critique — home `/` and shared chrome (Assessment A, design review)

Run 2026-09-01, branch `impeccable-redesign`. Mode: Persuade. Evidence: mobile 375×812 fully inspected in both schemes; desktop first viewport in both schemes plus computed-style measurement at 1280 (the pane would not paint below the fold at emulated desktop width). Isolated from detector output.

## Design-specificity verdict

**Mostly authored — but the first screen is borrowed, and the one module that could be nobody else's is buried.**

Authored: a live Leaflet preview of *this* park with 104 hand-surveyed pins in the hero; the `.art-band` system hanging Lucario, Mew and Magikarp off three band edges with arithmetic that clears the attribution block (`index.astro:1068-1080`, `2155-2288`, `2400-2421`); "Bramlett Field SLP" as a location line; the GO Fest group photograph with its credit burned on; empty states that name Wednesday evenings at the Campsite.

Pulling back toward generic:
1. **The first viewport is 38% Pokémon GO logotype** (`.hero-logo` 335×313 in an 812pt phone) over Niantic's Eevee-forest key art. The only Texarkana signal is the word TEXARKANA in borrowed lettering.
2. **The largest module below the hero is other people's content.** "Happening now" renders four full-bleed Niantic key-art cards (~1,600 CSS px on a phone); 8 of the page's 33 `<main>` links go to leekduck.com; 19 of 33 leave the site.
3. **The unmistakably-PoGo-TXK section — the community photographs — arrives at ~2,800px on mobile**, after that referral wall.

The composition argues "Pokémon GO, with a Texarkana branch" when the thesis is "Texarkana, with a Pokémon GO reason to turn up."

## Heuristics — 22/36 (Acceptable; 7 n/a on a Persuade surface)

| # | Heuristic | Score | Note |
|---|---|---|---|
| 1 | Status | 2 | `getFeed()` returns `stale`/`fetchedAt`; home discards both (`index.astro:167,195,199`). `FeedStatus` renders on raids/eggs/research, never on `/` |
| 2 | Real world | 3 | Terminology local and right; "Go" is a verb with no object for sighted users |
| 3 | Control | 3 | Escape and outside-click close menus; external links announce |
| 4 | Consistency | 2 | Three `h2` treatments (24 / 18.4 / 12.5px muted caps); Poké Ball means "menu" and "/go" in one header; 24px fix landed on the wrapping `<p>` not the anchors |
| 5 | Error prevention | 3 | `nextUp` three-deep fallback (`index.astro:96-136`); noscript map |
| 6 | Recognition | 2 | `.mini-name` nowrap+ellipsis at 10.88px (`index.astro:1703-1712`): 6 of 12 tiles clip; "Mega Latias"/"Mega Latios" both render "Mega Lat…" |
| 7 | Flexibility | n/a | Persuade |
| 8 | Minimalist | 2 | 5,960 CSS px on a 375px phone; five type sizes under 12.2px |
| 9 | Error recovery | 3 | Silent failure of account control and feeds |
| 10 | Help | 2 | "What is a Community Campsite?" is real help, placed last, after the term has been used three times |

## Cognitive load — 4 of 8 fail (high)
No single focus: 14 controls in the chrome before content. Hierarchy inverted (below). "In game today" = 12 tiles in 3 subgroups + 3 links in one card; "Happening now" = 6 exits, 5 off-site. Eggs and research shown in full *and* linked. Chunking (everything capped at 4) is done well — per strip, not per decision.

## Emotional journey
Opening strong but not about you. First valley at ~880px: four Niantic ads, each a one-way door. Peak at ~2,800px: the GO Fest photo. Second peak right after: "Next meetup — Mega Skarmory Raid Hour, Wed, Sep 2, 6:00 PM CDT, Bramlett Field SLP" with the RSVP button — under the smallest heading on the page. End: a glossary entry and a trademark notice, no closing ask.

## What's working
1. The map is the real map (`index.astro:432-450`), `client:visible compact`, with a noscript fallback naming the park.
2. Empty states better than most filled states (`index.astro:592-595`); the deliberate refusal to put `.empty-art-bg` under a feature description (`:740-750`).
3. `nextUp` resolution (`index.astro:82-136`) — "whichever comes first", hand-entered row wins ties. Truth over polish in a reducer.

## Priority issues
- **[P1] The conversion module has the smallest heading on the page** — `index.astro:1571-1577` `.card h2 { font-size: .78rem; uppercase; --text-muted }` → 12.48px. Measured ramp: 24 → 18.4 → 16 (event card h3s) → **12.48 "Next meetup"**. Fix: two h2 treatments; give "Next meetup" section-level weight or promote it to its own band under the hero. → typeset, shape
- **[P1] The biggest module below the hero exports the visitor** — `index.astro:462-534`, styles `2155-2346`. Fix: cap at two cards at small scale (or the `.posts` text-forward list), move below "Next meetup" and "The community", titles link to `/events`, Leek Duck demoted to a source line; `<Attribution />` stays. → shape
- **[P1] The page ends on a glossary entry and a disclaimer** — `index.astro:844-861`, then `Base.astro:428-457`. Fix: end on the ask (meetup + Discord), move the Campsite explainer beside the `★ Campsite 24` stat; consider a bottom-anchored "Open the map" on mobile. → shape
- **[P2] Game data with no freshness signal** — `index.astro:167,195,199` vs `raids.astro:86`, `eggs.astro:61`, `research.astro:57`. Fix: render `FeedStatus` in "In game today". → harden
- **[P2] Sub-12px type and truncation that destroys meaning** — `index.astro:1703-1718` (`.mini-name` .68rem nowrap; `.mini-tier` .6rem), `.card-subhead` .66rem (`:1731`), `.stats dt` (`:1475`). Five sizes at 9.6/10.56/10.88/11.84/12.16px; 6 of 12 tiles clip at 375. Contrast passes everywhere (4.61–18.4:1 measured). Fix: let names wrap; floor ~12px; collapse five micro-sizes to two. → typeset

## Persona red flags
- Casey (mobile): 5,960px page; "Next meetup" ~3,400px down; every nav target in the top ~430px (toggle at y=8, panel y=61→427); no bottom-anchored action. Positives: no horizontal overflow at 375; hero text on solid `rgb(11,14,19)`; 44px toggle, 48px CTAs.
- Jordan (first-timer): leftmost header item is the Pokémon GO logotype — reads as Niantic's site; the corrective disclaimer is 5,900px away. "Go" unexplained for sighted users. A Poké Ball is the menu button with no label, and the same mark is a nav destination two items right. "Campsite" undefined until the bottom. "Happening now" cards look like the site's own events.
- Sam (a11y): good foundations (skip link, `:focus-visible`, `aria-current`, `aria-expanded`, Escape returns focus, "(opens in a new tab)", reduced-motion swaps to a still). Gaps: `.card-links a` 18px and `.footer-links a` 16px tall (`index.astro:1739-1751` padded the `<p>`); header social links 22×22 with 10px gaps; "Next meetup"/"In game today" are `h2`s styled as eyebrows so the outline and the visual disagree.

## Minor
- Event/Season/GO Pass badge uses `--poi-powerspot` — the map's Power Spot colour — on the same page as the map (pinned light, 4.87:1: semantic collision, not a11y).
- CTA polarity flips in dark mode: "Open the map" becomes light-red with dark text while "Join the Discord" stays saturated blurple with white — the secondary reads louder.
- Discord appears four times; "Find us" adds nothing new; its four tiles are near-black on a light page.
- `.stats` — the survey, the most defensible claim — is 27px numerals with 11.84px labels under the CTAs.
- On mobile `.hero-map-open` sits over the Leaflet/OSM/Protomaps attribution strip.
- Account control renders nothing if `/api/me.json` fails (`Base.astro:395-401`).

## Questions
1. If the Pokémon GO logotype came out of the hero tomorrow, what would be left? What if the GO Fest photograph — sixty real people with Ambassador banners at Spring Lake Park — were the first viewport, wordmark small, map beside it, Wednesday's meetup the first thing you can act on?
2. Why is this page trying to be a Pokémon GO news site? 40% of its height is information identical in Dallas, Tokyo and Berlin. What if it refused any content not specifically about Texarkana and let the nav do its job?
3. What is the one thing a stranger should do in the first five seconds? If it is "open the map", everything else on that screen is competing with it.
