---
tags: [reference, design]
updated: 2026-08-07
---

# Design System

The tokens themselves live in `src/styles/global.css` and are commented there. This note is
about the rules around them and the decisions that are not visible in the CSS.

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
| Shiny Lucario | 280×431 | 0.65 | Home hero, right edge | The narrowest of the three. The hero shows a thin sliver, and a tall upright subject still reads from one where a round one is an unidentifiable curve |
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
