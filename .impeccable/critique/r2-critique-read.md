# Round 2 critique — read surfaces (Assessment A)

Run 2026-09-03 against the shipped Trail-Map Kiosk world. Targets: `/events`, `/raids` `/eggs` `/research`, `/blog` + post, `/about` `/conduct` `/privacy` `/terms` `/offline` `/auth/*` `/account/delete`. Inspected at 375 and 660–1440, both schemes.

## Verdict
**Authored, not templated — but thinner the further from `/events` and `/about`.** Best moments: `/about`'s survey panel (four discs + one red arrow), `/offline`'s four signposts, `/blog`'s caps date-stamp with a PINNED plate, `/raids`' TierBadge (the star count *as* the post number, with a local note). Weak: the disc has stopped meaning anything on `/eggs` (`1`, `2`, `5`… restating "1 km eggs"), `/research` wears no signature at all (bare `h2` + count, `research.astro:93-99`), and three sibling pages ship three section-head treatments.

## Heuristics — 27/40
1 Status 3 · 2 Real world 3 · 3 Control 2 (76 egg cards, 33 research tasks, no jump/filter) · 4 Consistency 2 (weakest: three head grammars; Discord button red on one page; `.here` says two things; `badge--live` carries "Permanent") · 5 Error prevention 3 · 6 Recognition 2 · 7 Flexibility 2 · 8 Minimalist 3 (RUNNING ×8 under "Running now"; ✦ SHINY on every reward tile) · 9 Recovery 3 (`/auth/error` names no cause) · 10 Help 4.

## Cognitive load
Reading pages low (1 fail: hierarchy — `/conduct` at 375: h1 31.9 / h2 22.15 / **h3 21** / **h4 18 at weight 800, heavier than h3**). Data pages high (4 fails). Heights at 375: `/eggs` 18,729px · `/research` 21,110px · `/events` open 13,954 · `/raids` 5,047 · `/blog` 5,158 · `/privacy` 5,129 · `/conduct` 2,943.

## Emotional journey
Peak: `/about` above the fold; `/offline`. Valley: `/events` with no meetups — heading, lede, dashed box, Discord button, freshness strip, one folded row, then a **235px credit block, the tallest element on the page**. Second valley: minute two of `/eggs`. Reassurance done right: `/account/delete`.

## What's working (do not regress)
1. The tier ladder (`raids.astro:166-186`, `TierBadge`, `ladderRank()` `:43-53`) — finished.
2. `FeedStatus`'s two stale voices + the Attribution's "we simply read it".
3. Empty states as statuses with the invitation in a solid element outside them.
4. `/gallery` → `/blog#photos` 301 with the fragment preserved.

## Priority issues
1. **[P1] `/eggs` and `/research` have no wayfinding.** Lift `raids.astro:113-137` `<nav class="g-jump">` into `src/components/game/JumpRow.astro` (already generic: `{key,id,count}`), render in `eggs.astro` after L83 (1 km 27 · 2 km 7 · 5 km 12 · 7 km 12 · 10 km 12 · 12 km 6) and `research.astro` after L75 (Catching 7 · Throwing 8 · Exploring 6 · Battling 3 · Team GO Rocket 1 · Training 4 · Buddy 4); CSS exists at `game.css:77-96`; consider sticky. → clarify
2. **[P1] The date outshouts the thing itself** — `EventCard.css:74` `.event-when` 21/700 over `:89` `.event-title` 18/700; same on the meetups board (`events.astro:495-510`). Swap: title `--text-xl`/800, when `--text-base`/700 tabular; `.meet-title` `--display-sm`, `.meet-when` meta. → typeset
3. **[P2] Vocabulary drift** — `account/delete.astro:37` `badge--live` "Permanent" (red now means danger too) → a `.badge--warn` on `--red-900` outline or `.badge--outline`; `account/delete.astro:105-108` `btn--primary` for "Sign in with Discord" → `btn--discord`; `.here` says "Happening now" (`events.astro:218`, `LiveBoard.tsx:874` — and there it fires on `rsvps.here > 0`, "someone arrived", a different fact) vs "Live now" (`index.astro:470, 661`) — one word; `/about` lacks the `.legal-meta` line its siblings carry. → audit
4. **[P2] The Attribution block outweighs the page** — 235px at 375 (`Attribution.astro:269-284`, `game.css:371-386`). Keep both paragraphs and links; set at `--text-sm` `--text-muted` above a 1px hairline like `.legal-note` (`legal.css:118-123`). Also move `<FeedStatus>` (`events.astro:292-297`) inside the `<details>` under its summary — it describes the game calendar, not the meetups. → quieter
5. **[P2] Heading ramp collapses at phone width** — `--display-sm` (`global.css:264`) and `--text-xl` (`:257`) compute to 22.15 and 21px at 375; `legal.css:76-78` sets h3 700 while h4 inherits 800. Raise `--display-sm` floor to 1.55rem (or h3 → `--text-lg`, h4 → `--text-base`/700, h4 lighter than h3). Give `/conduct` the `legal-toc`. → typeset
6. **[P3] 120 links, 60 named "On Leek Duck"** — `EventCard.astro:232-250` duplicates the stretched title link (`:184`); `blog/index.astro:307` "Where this was taken" ×9. Drop the second anchor (keep provenance as a non-interactive `.badge`), suppress `stateWord` when the group heading says it (`EventCard.astro:198`), extend the gallery link name or make it `.btn--sm .btn--arrow`. `/research` reward tiles repeat ✦ SHINY under a ✦ SHINY REWARD header (eggs solved this at `eggs.astro:102-104`). → distill

## Persona red flags
Jordan: `/events` reads as "nothing on it"; `/auth/error` names no cause; FOG/WINDY chips unlabelled; `/conduct` unskimmable. Casey: 23–26 screenfuls with no marker; calendar state set once by `matchMedia` (`events.astro:380-385`), never re-evaluated or remembered; first raid boss at y=734 after six pieces of preamble; nothing in the thumb zone. Sam: link lists of identical names; two `role="region" tabindex="0"` scroll containers on `/privacy` (`:71`, `:160`) with nothing to scroll at 375 — condition `tabindex` on overflow; Gazette link inside `.credit` 141×16px. Floor holds: dark-mode contrast clean (5.81–16.46), TOC 30px, chips 36px, tables fit.

## Minor
`.post` left rail width varies (disc vs 60px date block); calendar `<summary>` 36px; post-nav "NEWER / This is the newest post." styled as a peer of a live card; `/privacy` TOC is eleven red links on the quietest page; legal section numbers typed into headings where a disc would carry lookup meaning; dark-mode `/raids` shows two white current-page pills (header + GameNav); `/blog` "From the community" band dwarfs the two posts and its h2 sits close to the h1; `/about` credit is a `<figcaption>` while every other is a `<p>`.

## Questions
1. What does the disc mean now? Count (`27`) or section number — not the heading's first token.
2. Is `/events` the right page when there are no meetups? Promote the next three global events into the empty panel.
3. Does a 76-item egg pool want cards at all? A printed table is more in-world.
4. Why does the freshest data get the quietest treatment and the licence text the loudest?
5. What would a confident `/research` look like — drawn category icons in the `/go` family?
6. Does red now mean too much (chrome, live, current, irreversible)?
