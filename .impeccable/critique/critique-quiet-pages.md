# Critique — quiet pages (Assessment A, design review)

Run 2026-09-01, branch `impeccable-redesign`. Targets: `/about` `/conduct` `/privacy` `/terms` `/account/delete` (share `src/styles/legal.css`), `/auth/device`, `/auth/error`, `/offline`. Assessment A was isolated from detector output; detector evidence for these files is in `critique-detector.md`.

## Design-specificity verdict

**Partly authored — the prose is, the page isn't.** The copy is unmistakably this community's ("The park has patchy signal in places — try moving a few metres", "We are volunteers, not a security team"). The composition is any 2020s SaaS legal page: centred 68ch column, uppercase eyebrow, rule-underlined H2, sunken-grey callout, two-column TOC. Three tells:

1. `src/pages/about.astro:4` imports `legal.css` — the one persuasion page is dressed in the Terms of Service stylesheet; the photo is the only thing distinguishing About from Privacy.
2. The eyebrow is the same five characters on five pages (`about.astro:33`, `conduct.astro:19`, `privacy.astro:16`, `terms.astro:16`, `account/delete.astro:27` all read `PoGo TXK`), 40px below a header logo that says the same.
3. The stats row (`66 / 16 / 22 / 24 ★`, `about.astro:68-89`) is the only proof of the survey — the positioning claim — and it is unlabelled, mid-paragraph, styled like a footnote.

`/auth/device` is the strongest surface here: the code is demoted and the Discord button promoted, documented at `device.astro:252-258`.

## Heuristics — 25/40 (Acceptable)

| # | Heuristic | Score | Note |
|---|---|---|---|
| 1 | System status | 2 | No countdown on a 300s code; no `online` detection on `/offline`; `hidden` bug makes the panel lie |
| 2 | Real world | 3 | Warm and local; undercut by `ERROR 400` and "Back to the map" → `/` |
| 3 | Control/freedom | 3 | No back-to-top on a 5,579px privacy page |
| 4 | Consistency | 2 | One eyebrow ×5; one callout in four colours; `.btn` ×2 with different min-heights |
| 5 | Error prevention | 3 | The delete gate is well built |
| 6 | Recognition | 3 | TOC scrolls away, never returns |
| 7 | Flexibility | 2 | No print stylesheet on documents people are told to read |
| 8 | Minimalist | 2 | h3 = body size; three "muted" styles render at full contrast |
| 9 | Error recovery | 2 | Machine string louder than the human explanation |
| 10 | Help | 3 | Absent on `/auth/error` and `/offline` |

## Cognitive load — 3 of 8 fail
- Chunking: `/conduct` 8 undifferentiated bullets (`conduct.astro:43-62`); `/terms` TOC 13 items; `/privacy` 11.
- Hierarchy: measured h1 38.4 → h2 18.88 → h3 16.00 → body 16.00 (`legal.css:54-57`). h3 is body size.
- Working memory: `/privacy` is 5,579px (~7.7 phone screens), TOC gone at ~450px, no sticky nav or back-to-top.
- Standout pass: "The short version" (`privacy.astro:20-32`, `terms.astro:20-30`) is textbook progressive disclosure.

## Emotional journey
`/about` flat after the photo. `/conduct`: the pledge is italic muted body text in a grey box (`conduct.astro:100-108`); a binding arbitration clause is the last sentence under "Reporting" (`:74-77`); two identical grey boxes stacked at the end (`:86-96`). `/terms` §4 safety copy (driving, trespass, under-18s) renders identically to §12 "Changes". `/auth/device` stalls for five silent minutes then snaps to "expired". `/auth/error` is the worst moment: `ERROR 400` / "Something went wrong". `/offline` warm and empty-handed. `/account/delete` success is one grey sentence under a red warning that still describes what is about to happen.

## What's working
1. The voice, everywhere.
2. `/auth/device`'s inversion of the device-grant convention; Discord blurple `#5865f2` measured 4.61:1 and documented as "this button IS go to Discord".
3. The delete gate: server-rendered identity → "Not you?" → checkbox → disabled button → confirm. The About stats `<dl>` uses `column-reverse` so screen-reader order stays label-then-number.

## Priority issues
- **[P1] `hidden` defeated by `display`** — `device.astro:244` (`.code-panel { display: grid }`), `:292-306` (`.btn { display: inline-flex }`) vs `:41`, `:69`. Measured: "Get a new code" has `hidden === true`, computed `display: flex`, height 44.9px, receives focus. `unavailable()` (`:113-118`) therefore shows a working-looking Discord button under "not available right now"; first paint shows an empty code. Fix: `[hidden] { display: none !important }` in `global.css`; audit every `hidden` paired with a class that sets `display`. → harden
- **[P1] De-emphasis styles never de-emphasise** — `legal.css:59-62` `.legal p, .legal li { color: var(--text) }` (0,1,1) beats `.legal-eyebrow` (`:16`), `.legal-updated` (`:26`), `.legal-note` (`:107`) (0,1,0). Measured `rgb(29,29,31)` light / 16.46:1 dark on all five pages. Fix: scope the base rule to `.legal > p:not([class])` or raise the three. → typeset
- **[P1] `/auth/error` leads with an HTTP status and buries the help** — `error.astro:26` (`Error {status}`), `:28` raw `reason` at weight 600 in a red panel, `:29`/`:63-65` the `EXPLANATIONS` demoted to muted, `:33` "Back to the map" → `/`. Actions never adapt to `reason`. → clarify
- **[P1] `display: block` on `<table>` strips table semantics** — `legal.css:72-79`. Verified: the "Discord account ID" cell exposes as `generic`. Both privacy tables (`privacy.astro:69-82`, `:156-187`) lose header association; scroll region not keyboard-reachable. Fix: wrap in `div.legal-scroll[tabindex=0][role=region][aria-label]` with `overflow-x:auto; min-width:0`. → audit/harden
- **[P2] One callout in four meaningless colours** — `legal.css:30-36` (accent), `conduct.astro:100-108` (campsite yellow), `error.astro:56-62` (live red), `device.astro:277-284` (gym orange), `legal.css:100-108` (grey). `/account/delete:30-36` reuses `.legal-summary` for a destruction warning that `/privacy:20-32` uses for a friendly summary. Fix: one `.callout` with `--info / --warn / --status`; retire POI colours off the map. → distill
- **[P2] `/offline` hands over nothing to act on** — `offline.astro:10-21`: no links to cached routes, full nav+footer of dead links, both paragraphs muted, centred ragged text (`:29`), no `online` listener. → shape

## Persona red flags
- Jordan (first-timer): `ERROR 400`; "Back to the map" ≠ Map; three sign-in affordances on `/auth/device`; **"and you tapApprove."** (`device.astro:37-38`) and **"messages.Discord does not give them to us"** (`privacy.astro:110-111`) — the Astro whitespace trim, visible; `/conduct` and `/about` undated; delete's primary action is an inline text link (`delete.astro:66-70`, 21.2px); arbitration clause unheaded.
- Sam (a11y): focus-visible and skip link are good; a `hidden` button is in tab order; privacy tables are not tables; 300s deadline unannounced (`device.astro:186`); no non-visual "polling active" signal; press-photo credit at 10.88px (`about.astro:148-155`) over an unverifiable gradient — a licensing obligation that must be legible; TOC links 19.1px tall (`legal.css:124-130`).

## Minor
`/privacy` has no see-also footer; `/about` stats wrap 3+1 at 375px (`about.astro:161-169`, use a 2×2 grid); `.lede` 1.05rem is not a step; `.btn` defined twice (`device.astro:292` min-height 44, `error.astro:72` none); safety guidance duplicated and divergent (`conduct.astro:79-84` vs `terms.astro:76-92`); `/conduct` PDF link below the fold; `window.confirm()` on `/account/delete:100`; delete success has no closure; no print stylesheet; the `--accent`/`--accent-contrast` pairing on offline/error/device is **correct** — do not "fix" it.

## Questions
1. Why does `/about` import `legal.css`? What would About look like built from the evidence (104 points, 63 place photos, 9 community photos, three teams, one park)?
2. The stats row is the only unfalsifiable claim on the site. What if it were the hero?
3. What is a 5,579px privacy policy for on a phone in sunlight? Open collapsed with the TOC pinned?
4. `/offline` knows what's cached and won't say.
5. What would `/auth/device` feel like with the deadline visible?
6. h3 = body. What is a confident ramp: 38 / 24 / 18 / 16?
7. Five pages, one eyebrow, one word. What would each page say if it could?
