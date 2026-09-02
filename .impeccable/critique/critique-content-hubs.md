# Critique — `/events`, `/raids` `/eggs` `/research`, `/blog` + `/blog/[slug]` (Assessment A)

Run 2026-09-01, branch `impeccable-redesign`. Modes: Operate/Read. Inspected at 1280 and 375, both schemes; contrast and target sizes **measured on rendered pages** (computed values). Isolated from detector output.

## Design-specificity verdict

**Specific in voice, generic in structure, borrowed in imagery.**

Unforgeable: "Raid trains and remote invites get organised in the Discord" (`raids.astro:41`); "tell any ambassador on Discord and it comes down — no reason needed" (`blog/index.astro:307`); `FeedStatus` splitting one `stale` flag into two apologies (`FeedStatus.astro:133-136`); `EggCard`'s refusal to relabel Leek Duck's rarity scale (`EggCard.astro:332-334`).

Interchangeable: hero card with bottom scrim → pill nav → status bar → `auto-fill` card grid → attribution footer could be re-skinned for a recipe index without touching a rule. The three heroes are near-identical CSS with different `object-position`. Where the design reaches for character it borrows Niantic's: every one of the 60 cards on `/events` is vendor marketing art, six repeat the same rainbow blob, four the same Pokémon GO wordmark art — the most-repeated image on the page is the logo PRODUCT.md says is not used. `/eggs` is the exception and the proof: no borrowed art, sprite-as-identifier, reads instantly.

## Heuristics — 24/40 (Acceptable)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Status | 3 | `FeedStatus` excellent; `/events` has **no freshness indicator** on the same feed |
| 2 | Real world | 3 | Raw upstream taxonomy leaks: a badge reading "Event" on the events page; "GO Pass"; a 5-dot rarity the page admits it can't interpret |
| 3 | Control | 2 | One filter across six surfaces and it is a no-op on current data ("18 bosses · 18 can be shiny"); 60 cards, zero filtering; no way to see only meetups |
| 4 | Consistency | 2 | Three page architectures across five siblings; two attribution treatments; credit-on-image honoured in one place, broken in another; POI tokens carrying four meanings |
| 5 | Error prevention | 3 | `aspect-ratio` reservation, `stripTags`, NaN-guarded rarity, page clamp, tag normalisation |
| 6 | Recognition | 2 | Tier set in the smallest type on the page (11.5px, `game.css:267`) with an 8px dot; shiny is a 15px sparkle with no word; rarity legend ~1,900px below its dots |
| 7 | Flexibility | 1 | Daily reference pages used at a gym: no jump-to-tier, no sort, no "5-star only"; `/events` is 13,983px with no in-page navigation |
| 8 | Minimalist | 2 | Wall of duplicated vendor art, 60 redundant "Details" buttons; photo band renders as nine black rectangles; heroes eat 380–600px |
| 9 | Error recovery | 3 | Empty states specific; loses for `/research` voids and no `.g-art` fallback |
| 10 | Help | 3 | `tierNote()` / `poolNote()` are real help; `.blog-tag-count` measures 3.22:1 |

## Cognitive load — 5 of 8 fail (high)
On `/raids`: 1-Star (soloable) occupies 622px from y=861; **5-Star — the tier the page's own note says raid trains organise around — is 1 card at y=2,169.** Space allocated by row count, inverted against what a raider at a gym needs.

## Emotional journey
Peak: the post page `/blog/four-new-pokestops-spring-lake-park` — a Before/After table (11 stops per lap → 16) and a numbered walking route; the best-designed surface in the audit. Valley 1, the worst moment on the site: the `#photos` band at desktop shows no photographs — seven of nine `figcaption`s are 97–115% of tile height under a 0.93-black scrim (`blog/index.astro:725-740`); one is clipped mid-sentence. Valley 2: scrolling 2,169px past soloable bosses. Both data hubs end on licence text.

## What's working
1. `FeedStatus` (`FeedStatus.astro`) — relative *and* absolute time; two stale voices; `role="status"` deliberately withheld.
2. `tierNote()` (`raids.astro:33-43`) and `poolNote()` (`eggs.astro:32-42`) — hand-written, counted off the feed.
3. Focus visible and `:focus-visible`-gated; zero horizontal overflow at 375 on every route; aspect-ratio reservation; the `.event-card` stretched-link anchored on the title.

## Priority issues

### `/blog`
- **[P0] The gallery shows no photographs at desktop width** — `blog/index.astro:698-699` `minmax(240px,1fr)` on `grid-auto-rows: 190px`; measured caption heights 151, 151, 202, 201, 184, 201, 184, 218, 201px in 190px tiles; the 218 is clipped at the top. Fix: size tiles from the caption, or keep **only the credit** on-image (all the licence requires) and move caption/where below, or reveal caption on hover/focus with the credit pinned. → layout
- **[P1] Post hero credit renders beneath the image** — `blog/[slug].astro:124`, `:257-261`. Breaks the binding rule; the index gallery gets it right. Fix: reuse the `.photo-grid figcaption` on-image pattern. → harden
- **[P2] Standalone links under 24px** — `.photo-where a` 15px ×9 (`blog/index.astro:764-771`), `.post-card-tags a` 18.8px (`:621`), `.post-back a`/`.post-taglist a` ~19–21px; `.post-byline time::before` emits `·` unconditionally (`[slug].astro:228-231`) → "· August 4, 2026". → audit
- **[P3] `.blog-tag-count` 3.22:1** — `blog/index.astro:510-513`, muted + `opacity:.7` composites to `rgb(143,143,149)`.

### `/raids` `/eggs` `/research`
- **[P0] 72 of 74 images on `/raids` hotlinked from leekduck.com** — measured `{cdn.leekduck.com: 18, leekduck.com: 54, localhost: 2}`. `RaidCard.astro:31`, `:57`, `EggCard.astro:45`, `ResearchCard.astro:36`, `TypeChips.astro:26` bypass `proxiedImageUrl()`; `TypeChips.astro:191` documents the breach in a comment. No `.g-art` fallback. Fix: route all five through the proxy; `background: var(--bg-sunken)` fallback. → harden
- **[P1] Two measured AA failures in light mode** — `.g-fact--boosted dd` (`game.css:154-156`) `--poi-gym` on white = **3.15:1** at 12.8px (weather-boosted CP); `.g-shiny` (`game.css:304-307`) `--poi-campsite` on white = **2.08:1**, the only visible shiny carrier. Both pass in dark → verification was run dark-first. Fix: darkened text tokens (as `--team-instinct` already is); give shiny a word on the card. → audit
- **[P1] The tier ramp is not a ramp and borrows the map's semantics** — `game.css:278-300`: 1★ `--text-muted`, 3★ `--poi-pokestop`, 5★ `--poi-campsite`, Mega `--poi-powerspot`, Shadow `--team-valor`. No ordinal direction; `--poi-gym` simultaneously means Gym, boosted CP, stale-feed border and the location icon (`EventCard.css:331`). Fix: an ordinal tier ramp with a shape/star-count; size the tier badge as the heading it is; lock `--poi-*` to the map. → colorize
- **[P1] Three sibling pages, three architectures; the important tier buried** — `/raids` opens with a 360–600px hero (`raids.astro:189-193`), `/eggs` and `/research` with `.g-head`. 861px of chrome above the first card at desktop; at 375 the hero is a solid black box (`raids.astro:272-279` flattens the scrim to 0.70–0.74). Fix: one architecture, no hero; a tier jump-row beside `GameNav`. → distill
- **[P2] `/research` rows leave ~250px voids** (`game.css:76-86` stretch); `/eggs` renders `●●●●○` on all 27 species and the sparkle on 26 of 27 — two channels saying nothing.

### `/events`
- **[P0] Promises local, delivers 60 vendor cards with no way to find the local ones** — lede `events.astro:138-141`; measured 8 running + 52 upcoming = 60 cards, zero meetups, 13,983px; `groupEvents` interleaves by time; no filter, toggle, jump nav; 12 badge labels, none clickable. Fix: meetups get their own band at the top; Meetups / Everything toggle; global calendar behind a disclosure. → shape
- **[P1] Card hierarchy inverted** — `EventCard.css:185-192` full-bleed 16:9 banner is the least distinguishing element; title 1.06rem, time 0.86rem; group headings 0.82rem muted caps. Fix: thumbnail art, promote time and title, real group headings. → typeset
- **[P2] 60 redundant "Details" buttons** duplicating the stretched link (`EventCard.astro:141-150`) — 120 links to leekduck.com, ~130 tab stops, zero links back into the park. Drop or replace with something local.
- **[P2] No freshness, weaker attribution** — neither `FeedStatus` nor `Attribution.astro` renders; bespoke credit at `events.astro:219-242` sits at y=13,691 of 13,983 and omits the no-ads/no-paywall clause. Obligation met where nobody reads it.

## Persona red flags
- Jordan: nine black rectangles where the proof should be; 60 cards of marketing, "Texarkana" once; no explanation of tiers; two hubs end on licence text.
- Casey: 861px before the first card; phone hero a solid black box after downloading 61KB; `.g-card` 343px wide holding a 96px sprite (~90% air); 15px `.photo-where` links; shiny filter lost on back-navigation; no scroll anchor on 13,983px.
- Sam: two measured AA failures in light mode; eleven standalone links under 24px; photo `alt` falls back to the caption (`blog/index.astro:270`) which is also rendered → read twice. Correct: focus, `role="timer"`, "(opens in a new tab)".

## Minor
Shiny filter is a no-op on current data; `.g-chip--type` at 15% tint makes 18 hues indistinguishable (`game.css:191`); rarity legend far from dots (`eggs.astro:104-107`); `/research` reward names 0.72rem, CP 0.68rem (~10.9px); `.events-note` uses `--poi-campsite`, `.g-status--stale` uses `--poi-gym` for the same message class; `.event-badge` "Event" is upstream `heading` unfiltered (`EventCard.astro:41`); `.post-nav` "Older →" alone right-aligned reads as an accident; `.event-image` has a failure fallback, `.g-art` does not.

## Questions
1. If the artwork disappeared tomorrow, would `/events` be worse or better? A 64px thumbnail with the time as the biggest thing on the card.
2. What is `/events` for? Start from "here is what *we* are doing"; the global calendar as context.
3. Should the map palette be allowed outside the map? Lock `--poi-*` to the map; give the game pages a ramp that ascends.
4. What does `/raids` look like with no hero and 5-star in the first viewport?
5. The gallery hides photographs to satisfy a licence that only requires the byline on the image.
6. Almost all the measurement in this codebase was done in dark mode. What else hides in light?
