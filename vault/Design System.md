---
tags: [reference, design]
updated: 2026-08-10
---

# Design System

The tokens themselves live in `src/styles/global.css` and are commented there. This note is
about the rules around them and the decisions that are not visible in the CSS.

## The palette is a Poké Ball

Repainted 2026-08-10. Red top, white bottom, black band — replacing the navy and cream inherited
from the old site. Justin's call: the blues were not wanted.

| | Light | Dark |
|---|---|---|
| `--accent` | `#c8071c` | `#ff5c6e` — **inverts** |
| `--accent-solid` | `#c8071c` | `#c8071c` — never inverts |
| `--bg` / `--bg-panel` | `#f7f7f8` / `#ffffff` | `#141416` / `#1e1e22` |
| `--text` | `#1d1d1f` (16.83) | `#f2f2f4` (14.86) |
| ink ramp | `#0f0f11` → `#3d3d44` — the black band |

> [!warning] Hue, not just lightness
> Every red sits at **hue 353–354°**, approaching pure red from the crimson side. The first
> attempt used `#c41810` at hue 2.7° — technically red, but *warmer* than pure red, and it read
> as orange on sight. Keep green below blue in any new red.
>
> The obvious Poké Ball reds fail AA outright: `#ff0000` is 4.00:1 on white, Pokémon red
> `#ee1515` is 4.42, Pokémon GO's `#e3350d` is 4.39. The ramp starts at the first red that passes.

The header is the ball's red top, with a 4px near-black `border-bottom` as the band and the white
page below. The "Go" nav chip is black — it was orange at 3.18:1, and it must not be white
because a white chip already means "current page".

### `--accent-solid` exists because `--accent` inverts

In dark mode `--accent` becomes a light red so it can be read as link text. That makes
`background: var(--accent)` + `color: #fff` a 3.0:1 failure there. Ten components did exactly
that, the site header among them — see [[Bugs Worth Remembering]]. Any filled surface with white
text uses `--accent-solid`. The same applies to POI colours, which lift in dark mode for the
basemap: `--poi-powerspot` behind white text measured 3.18:1, so the event badge pins the
light-theme purple.

Verified by auditing computed contrast on the rendered pages rather than reading the stylesheet:
**0 failures** on `/` and `/events` in both themes, 91 and 193 elements checked.

## Two skills drive visual work

Agent skills, in `.claude/skills/`, loaded automatically whenever anything visual changes.

| Skill | Origin | Job |
|---|---|---|
| `frontend-design` | Anthropic, Apache 2.0, vendored byte-for-byte from the official plugin marketplace | Taste. Two passes — plan, critique the plan, *then* build |
| `pogotxk-design` | Ours | Constraints. Palette, accessibility floor, licensing, layout traps |

They are meant to disagree occasionally. `pogotxk-design` wins, because its rules are licences
and accessibility rather than preferences.

> [!note] The cream collision
> `frontend-design` names "warm cream background with a terracotta accent" as one of three looks
> that mark a page as AI-generated. Ours is `#eef1e7` with `--poi-gym: #e2703a`, which trips that
> description exactly — but it is inherited from the old site's `theme-color` `#123254` and its
> cream, so it is a documented brief, not a default. The skill's own rule is that the brief wins.
> Do not "fix" the cream. Do question anything else that drifts toward that look.

`frontend-design` is vendored rather than installed as a user plugin so it travels with the repo
and applies for anyone who clones it. Apache 2.0 permits this; `LICENSE.txt` sits beside it
unmodified. Upstream is `plugins/frontend-design` in `anthropics/claude-plugins-official`.

## The photographs — what we actually have

Worth stating plainly, because the numbers were misread once and it changed a design decision.

| | Count | Where they appear |
|---|---|---|
| POI photos (`kind = 'photo'`) | 63 | Map popups, and the home page landmark rail |
| Community photos (`kind = 'community_photo'`) | 9 | `/gallery`, pinned on the map, four on the home page |

**72 is the total, not the community count.** They are different things and carry different
obligations. The 63 are photographs of the *places* — Bramlett Field's scoreboard, the disc golf
sign at Main Course Hole #8, the Spring Lake Park mural. They carry **no credit**, so they are
free to use decoratively. The 9 are photographs of *people*, several of them Texarkana Gazette
press photos whose credit must render on the image — see [[Attribution Obligations]].

That difference is why empty states use our own map-pin motif rather than photography, and why
the landmark rail can be photo-first with no caption.

55 of the 63 are portrait phone shots.

## Pokémon artwork

Official artwork from the [PokéAPI sprite collection](https://github.com/PokeAPI/sprites),
`sprites/pokemon/other/official-artwork/` — 475×475 transparent PNG, converted to WebP at
quality 82 and stored in `public/art/`. That conversion took the three files from 358KB to 73KB.

> [!warning] The CC0 does not mean what it looks like
> That repository is distributed under CC0, but its licence file opens with **"All image
> contents within are Copyright The Pokémon Company."** CC0 cannot waive rights the
> contributors never held. Using this artwork is the same unofficial fan-use position the site
> already takes, disclaimed in the footer, `/about`, `/terms` and `/privacy` — no worse than the
> Leek Duck sprites already on the site, and no better. See [[Attribution Obligations]].

Unlike Leek Duck's sprites and the Gazette's photographs, this artwork carries **no per-page
credit obligation**, which is the only reason it can be used as decoration at all.

### Which Pokémon, and where

Chosen by Justin. Assignment to a slot is by **silhouette**, because each slot crops differently:

| Pokémon | Trimmed | Ratio | Where | Why that slot |
|---|---|---|---|---|
| Shiny Lucario | 280×431 | 0.65 | Home hero — **in the gap** ≥1080px, right edge below | Narrow enough to stand between the copy and the map without touching either |
| Mew | 425×431 | 0.99 | Home, "Happening now", **left** edge | Alternates sides so the page is not a column of art down one margin |
| Incineroar | 224×406 | 0.55 | Home, "Happening now", right edge | Flanks Mew. The narrowest piece we have, which is what lets it sit in the margin of a section whose cards run edge to edge |
| Magikarp | 386×431 | 0.90 | Home, Campsite explainer | The roomiest slot, and it is the section about **Spring Lake** Park |
| Moltres | — | 1.0 | `/about`, left edge | Left from the earlier set; see the note below |

> [!note] The birds came first
> The original set was the three team legendaries — Articuno, Zapdos, Moltres — because the hero
> lede says the community is *"run by trainers from all three teams"*. Justin picked different
> Pokémon for the home page, so only Moltres survives, on `/about`. That leaves it as the last
> member of an abandoned set rather than part of a system. Either give `/about` one of the
> current three, or restore the birds — but do not leave it as an accident.

### Importing a new one

Trim before converting. The official artwork is always a 475×475 square with the subject floating
in transparent padding; untrimmed, a wide subject renders at roughly half the box height under
`background-size: contain` and the CSS box stops describing the art. `sharp(src).trim({ threshold: 0 })`
then WebP at quality 82. Record the resulting ratio and set `--art-ratio` — leaving it at the
default `1` puts a tall subject in a box far larger than itself, and then no position value means
what it says.

### `.art-band` — the one rule that serves all of them

In `global.css`. A full-width block with `overflow-x: clip`, and a `::after` driven entirely by
custom properties (`--art-src`, `--art-w`, `--art-right`/`--art-left`, `--art-top`/`--art-bottom`,
`--art-opacity`).

- **The band must be full-width.** Art anchored to a `max-width` container stops at the content
  box instead of the screen, which is the whole point of a bleed.
- **`overflow-x: clip`, not a bare negative offset.** Clip crops past the viewport edge *without*
  adding to the page's scroll width. A negative offset alone puts the site straight back into the
  169px horizontal-overflow bug in [[Bugs Worth Remembering]].
- **A background image, not an `<img>`.** Decoration, and CSS backgrounds are invisible to
  assistive tech by default — no alt text to get wrong.

**`--art-flip: -1`** mirrors a piece, for when a placement changes which way a subject should be
looking. Safe next to `z-index: -1` — a transform makes the pseudo a stacking context for its own
descendants, of which it has none, and does not lift it in front of the band's content. Verified:
the computed `z-index` stays `-1` and nothing overlaps.

### Standing Lucario in the hero's gap

Above 1080px he is not bled off the edge at all — he stands in the empty strip between the end of
the copy and the left edge of the map, mirrored so he faces the map.

The offset is *derived from the grid*, not guessed, because the hero is a centred 1100px box
inside a full-width band: outer gutter `(100% − heroWidth)/2`, plus the map column
`(heroWidth − 40 − gap)/2.15` (1fr of `1.15fr 1fr`), plus the hero's 20px padding, plus a 12px
gutter off the map.

> [!warning] Size him to the gap, which is 124–158px — not to preference
> At 145px he touched the lede's longest line with **0px to spare at 1920**, one rewrap away from
> sitting at full opacity behind body copy. `clamp(108px, 9.5vw, 130px)` holds 15–16px of
> clearance from the copy and 12px from the map at every width from 1080 to 1920.
>
> Measure the copy's rightmost **glyph** with a `Range`, not the column's box — `.stats` spans the
> full column and would report a false collision.

Below 1080px the columns are too tight to hold him, so he reverts to the edge bleed, unmirrored;
below 820px the layout is single-column and he drops to atmosphere behind the headline.

**A band can carry a second piece** via `::before` and the matching `--art2-*` variables, for a
section wide and tall enough to be flanked on both sides. "Happening now" is the only one that
qualifies — 627px tall at 1440.

The opt-in is `content: var(--art-2nd, none)`. `content: none` means the pseudo-element is never
generated, so the other bands pay nothing for a feature they do not use; a band turns it on by
setting `--art-2nd: ''`. Verified: `::before` reports `content: none` on `.hero-band` and
`.campsite-band`, and `content: ""` with the Incineroar background only on `.onnow-band`.

### How big it can actually be

Two separate limits, and both bite.

**Horizontally, the gap decides.** They differ enormously:

- **Hero: ~118px** between the map card and the screen edge at 1280. A first pass at 320px hid
  157px of the art behind an opaque card. It cannot go in front either — the map's bottom-right
  corner carries the OpenStreetMap/CARTO attribution, which must never be covered.
- **Campsite: ~798px** at 1600, because those paragraphs are capped at 68ch and everything else
  on the home page is edge-to-edge cards. This is the only home slot where art is nearly whole.
- **"Happening now": the outside margin only.** Its cards run edge to edge, so there is no clear
  space inside the container at all.
- **`/about`: ~490px each side**, since `.legal` is a 68ch centred column. `.legal` is shared with
  Terms and Privacy and its own comment says no decoration should compete with the text, so the
  band wraps it rather than restyling that class.

> [!warning] Vertically, the band's height decides — and nothing crops it
> `overflow-x: clip` leaves `overflow-y` computing to **`visible`**, not `clip`. A spec quirk:
> `visible` only degrades to `auto` when the other axis is something other than `visible` *or*
> `clip`. So art taller than its band is **not** cropped — it spills into the neighbouring
> section, behind its content. An early Zapdos at 420px tall in a 295px section would have
> overhung "Find us" by ~125px.
>
> Size against band height, and if a slot needs more room give the band padding rather than
> letting the art escape. `.campsite-band` carries `padding-bottom: clamp(0px, 5vw, 76px)` for
> exactly this reason.

Measured at 1440: no vertical spill on any band, 0px page overflow, and 413–670px of clearance
between the campsite text glyphs and the art. Note *glyphs* — a block-level `<h2>` spans the full
container, so its box overlaps art that its text comes nowhere near. Measure with a `Range`, not
`getBoundingClientRect` on the element.

**Below ~820px (1000px on `/about`)** every layout goes single-column and the margins vanish.

**Below ~820px (1000px on `/about`) every layout goes single-column and the margins vanish.**
There the art drops to ~0.16 opacity as atmosphere, because full opacity behind body copy cannot
be made to hold 4.5:1 at every scroll position.

## The home page, in order

Reordered 2026-08-10 at Justin's direction. The shape is: who we are → what is on → who we are
again → the detail → where to find us.

| | Section | Why here |
|---|---|---|
| 1 | Community banner | A community site should open with the community |
| 2 | Hero — copy + live map | Where we are |
| 3 | **Happening now** | Directly under the map: whether anything is on there today |
| 4 | **The community** (photos) | |
| 5 | Next meetup · Right now · In game today | |
| 6 | Community news | |
| 7 | **Places you already know** (landmark rail) | The "go and look" note the page ends on |
| 8 | Find us (socials) | |
| 9 | What is a Community Campsite? | |

Moved **in the markup**, never with CSS `order` — reading order and focus order have to match what
is on screen.

> [!note] The licence notice moved with its section
> `Attribution` lives inside "Happening now", so it now sits *above* the "In game today" card
> whose raid sprites it also covers. Leek Duck's terms require visible credit on the page, not
> adjacency, so this is still compliant — but do not "tidy" it out of the page on the grounds that
> the events section no longer needs it.

## The community banner

Full-bleed photograph at the very top of the home page, above the hero copy — GO Fest 2026 at
Spring Lake Park, about sixty members with the two Ambassador banners. A newcomer's first
impression of a community site should be the community.

Above the copy rather than behind it, deliberately: no text sits over the photograph, so the
faces stay unobscured and the contrast question never arises.

### Art-directed, and sized so `cover` never crops the people

Two crops, not one scaled image. A sixty-person group shot 3.4× wider than it is tall renders
every face about three pixels across on a phone.

| | Source crop | Ratio | Cap | `object-position` |
|---|---|---|---|---|
| `≥900px` | x60–2600, y800–1540 | 3.432 | 600px (760 ≥2400, 980 ≥3600) | `center 78%` |
| `<900px` | x900–2100, y960–1520 | 2.143 | 400px | `center 55%` |

**The CSS box takes each crop's own ratio**, so at ordinary widths `cover` has nothing left to
trim. Only `max-height` makes it crop at all, and the low `object-position` protects the group
when it does — losing treetops is free, losing the front row's feet is not.

> [!note] Verify against the group's real coordinates
> The group occupies **y 1040 (highest heads) to y 1465 (feet)** in the original. The first
> version used a fixed `clamp()` height against a crop with far too much tree in it and sliced
> the front row off at the waist on desktop. A sweep of every width from 320 to 5200 in 4px steps
> is the check that matters — it caught 3840 cutting the heads by 26px, which no single
> screenshot would have.

Served at 600/900/1200w (tight) and 1200/1600/2400w (wide). A phone takes 34–58KB rather than
the 461KB the first version was handing it.

### The caption scrim needs its own check

The automated contrast audit skips anything over a background image, so the caption has to be
measured by compositing the scrim over the actual photo pixels. Currently **16.6:1 on the credit
and 16.4:1 on the link at desktop, 14.9 and 17.0 on mobile**.

It ramps to 0.86 black by 72% of the caption height, not 46%. At 46% it was fine while the
caption was a single row; on a phone it wraps to two, and the credit landed in the weak part of
the ramp at **3.49:1** — under AA, and invisible to every check except this one.

> [!warning] The bin was not removed, and should not be
> Justin asked for a refuse bin to be retouched out. It sits at x2620–2880, y1290–1640 of the
> original — and two members are standing directly behind it, with the bin covering their shins
> and shoes. Removing it means **inventing two real people's legs and feet** in a documentary
> photograph that carries a named photographer's credit and links to a news article. No
> inpainting model is installed either (ComfyUI has only audio and video checkpoints), so the
> alternative was cloning a third person's legs into the frame.
>
> The crop stops at x2600 instead. That costs two members at the right edge — a man in a cap with
> his arm around a friend — which is why the caption links to `/gallery`, where the complete
> frame with everyone still lives. **If this is ever revisited, crop or ask Nick for a different
> frame; do not synthesise the people.**

The original media row is untouched. The banner is a derived crop in `public/hero/`, so
`/gallery` and the map popups still serve the full photograph.

## The landmark rail

Home page, directly under the hero. Eighteen of the 63 POI photographs in a horizontal rail,
each linking to `/map?poi=<slug>`.

The reasoning, since the shape looks arbitrary otherwise:

- **A rail, not a grid.** The photographs are overwhelmingly portrait. Eighteen portrait crops
  in a grid is a wall. A row that runs off the edge is also the honest statement: there are more
  of these than fit.
- **Gyms first, then by name.** Gyms are where people stand around together, so the rail opens
  on the places that matter for a raid. The order must be deterministic — it must not shuffle
  between requests.
- **Capped at 18** with a nineteenth tile linking to the map. Sixty-three `<img>` elements is a
  lot of DOM for a teaser.
- **`alt=""` on every tile image.** The place name is right there as visible text and the link
  takes its name from it; real alt text would announce every place twice.
- **Edge-to-edge below 720px** via a negative margin exactly equal to the section's own padding,
  added straight back as padding. The scroll area widens and the page gains no overflow.
- **8px of vertical padding on the rail.** `overflow-x: auto` forces `overflow-y` to compute to
  `auto`, so anything drawn outside the box is clipped — including the 5px `:focus-visible` ring.

It exists because the hero says "104 locations" and that was an abstract number. A local
recognises three of these instantly, and the map popup opens on the same photograph, so the
handoff is visually continuous.

## See also

[[Attribution Obligations]] · [[Never Touch the Game]] · [[Bugs Worth Remembering]]
