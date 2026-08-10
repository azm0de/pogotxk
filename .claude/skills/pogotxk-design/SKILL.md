---
name: pogotxk-design
description: The PoGo TXK design system and the constraints around it — palette tokens, the accessibility floor, the licensing rules that govern which images may appear where, and the layout traps this codebase has already been bitten by. Use when changing anything visual: CSS, layout, imagery, colour, components, or a page's structure.
---

# PoGo TXK design

A community site for Pokémon GO players in Texarkana, TX/AR. It replaced a
hand-maintained static site, and it is used mostly one-handed, outdoors, in
sunlight, while walking. That is the brief. Design for a glance, not a session.

Pair this with the `frontend-design` skill: that one supplies taste, this one
supplies the constraints. Where they disagree, this one wins — its rules are
licences and accessibility, not preferences.

> [!warning] Never edit CSS with `sed -i` or `perl -i`
> Both replace the file rather than writing in place, which silently breaks
> Vite's file watcher. The dev server then keeps serving the *previous* CSS with
> no error anywhere, and every measurement taken afterwards is against stale
> styles. This has already cost one debugging session. Use the Edit tool; if a
> bulk edit has already happened, restart the dev server before believing
> anything you measure.

## The palette is a Poké Ball

`src/styles/global.css` holds every token. Red top, white bottom, black band.
Chosen by Justin, replacing the navy-and-cream inherited from the old site.

Never introduce a raw hex value in a component. If a colour is needed, it is
either an existing token or a new token added to `global.css` with a comment and
its measured contrast ratio.

### Hue matters as much as lightness

Every red in the ramp sits at **hue 353–354°** — approaching pure red from the
crimson side. A red at hue 2–6° is *warmer* than pure red and reads as orange or
brick; the first version of this palette did exactly that and was rejected on
sight. **Keep green below blue in any new red.** The moment G rises above B it
starts drifting orange again.

The obvious Poké Ball reds also fail AA outright: `#ff0000` is 4.00:1 on white,
Pokémon red `#ee1515` is 4.42, Pokémon GO's `#e3350d` is 4.39. The ramp starts at
the first red that passes. These were measured, not picked — do not "correct"
them back towards the brand reds.

### `--accent` and `--accent-solid` are not interchangeable

This is the single easiest thing to get wrong here.

```css
--accent: var(--red-700);       /* light: #c8071c · dark: #ff5c6e (INVERTS) */
--accent-solid: var(--red-700); /* deep red in BOTH themes */
```

`--accent` **inverts** between themes: in dark mode it becomes a *light* red so
it can be read as link text on a dark page. That means `background: var(--accent)`
paired with `color: #fff` is white-on-light-red in dark mode — 3.0:1.

Ten components did exactly that, including the site header. Any filled surface
carrying white text uses **`--accent-solid`**. The same trap applies to
`--poi-powerspot` and every POI colour: they lift in dark mode for the basemap,
so a badge with white text must pin the light-theme value.

### The two live tokens are not a duplicate

```css
--live: var(--red-600);      /* a filled surface; white on it — 5.57:1 */
--live-text: var(--red-700); /* the same idea as text on the page */
```

A surface must be dark enough for white to sit on it, while text must contrast
with a *light* page in one theme and a *dark* page in the other. They invert
between themes. Do not collapse them.

Note that red no longer uniquely means "live" now that the whole brand is red —
the live signal leans on its pulse animation and the word "Live", which the site
required anyway, because colour is never the only signal here.

`--team-instinct` is likewise darkened via `color-mix` before use as text.

## The accessibility floor

Not aspirations. These have all been fixed once already, and a regression is a
regression.

- **4.5:1 minimum** on text. Check any new colour pairing in both themes.
- **24px minimum target** for standalone links and controls (WCAG 2.2 SC 2.5.8).
  Links *inside a sentence* are exempt — do not pad those, and do not count them
  when auditing. The fix pattern in use is `display: inline-block` +
  `padding-block: 5px`, with negative margin if the visual spacing must not move.
- **Every animation needs a `prefers-reduced-motion` escape.** Pages define their
  own; `global.css` also has a blanket rule, but scoped `transform` on `:hover`
  survives it and must be cancelled explicitly.
- **Visible keyboard focus** — `:focus-visible` is styled globally; do not remove
  outlines locally.
- **Colour is never the only signal.** Flare kinds have a coloured left edge
  *and* a spelled-out badge. POI types differ in hue *and* silhouette so the map
  survives greyscale and colour blindness.
- Decorative images take `alt=""`. Meaningful ones get real alt text.

## Layout traps this codebase has hit

**`min-width: 0` on flex children.** A flex item will not shrink below its
content, so `overflow-x: auto` silently does nothing without it. One missing
declaration put 169px of horizontal overflow on all twelve routes at 375px, in
production. Any flex or grid child that contains long text, a table, or a scroll
region needs `min-width: 0`.

**Astro trims trailing whitespace** before an element on the next line. Text
ending a line, followed by `<a>` on the next, renders with no space between
them. Use `{' '}`.

**Scoped styles cannot reach into a child component** — use `:global()`, and
remember the child's own padding may be cancelled by a negative margin inside it
(see `.event-image`); changing one side without the other leaves a sliver.

**Cards in a row are stretched to equal height by grid.** A second line of text
in one costs a few pixels of row height, not a broken layout — prefer wrapping
over truncation when the truncated part carries meaning.

## Which images may appear where

This is licensing, and it is the constraint most likely to be broken by an
otherwise good design idea.

**Leek Duck / ScrapedDuck** supply raid bosses, eggs, research and the global
event calendar. Their terms require, on any page using the data: no paywall, no
advertising, and visible credit to **both** projects. Render
`~/components/game/Attribution.astro`, and place it **outside** any empty-state
conditional so it survives a failed fetch. This has already been breached once —
event artwork shipped on the home page crediting only Leek Duck, and never
naming ScrapedDuck.

All their imagery goes through our proxy — `proxiedImageUrl()` and
`/img/leekduck/[...path]` — never hotlinked. It is their bandwidth, and a cached
copy survives them adding hotlink protection.

**Community photographs.** Several are Texarkana Gazette press photos. The
credit is a licensing obligation and must render **on** the image, not in a
caption beneath it, so a crop or a screenshot cannot separate them. This rules
out using photos as faded backgrounds, in decorative collages, or anywhere a
credit cannot ride along. That is why empty states use our own map-pin motif
(`.empty-art-bg`) instead of photography.

**Nintendo / Niantic / The Pokémon Company.** The site is unofficial fan work.
Do not use the Pokémon GO logo — Justin's explicit call. Map markers are
original SVGs, deliberately not ported from game art. The footer disclaims
affiliation.

**Brand logos** on the socials row are each brand's real app icon, for
uniformity. They bring their own background, so no chip behind them.

## Never touch the game

`vault/Never Touch the Game.md` is a hard project rule: no screen capture, no
accessibility-service scraping of the game, no process hooking, no GPS mocking,
**no scraping Niantic or Campfire APIs**. The reason is not ours to trade away —
*"Not our account. Community members' accounts."*

A design idea that needs live gym state, raid timers or player positions is not
buildable. Public feeds and our own hand-surveyed data only.

## Where things live

| | |
|---|---|
| Tokens, resets, `.empty-art-bg` | `src/styles/global.css` |
| Header, footer, page chrome | `src/layouts/Base.astro` |
| Page-specific CSS | scoped `<style>` in the `.astro` file |
| React island CSS | a sibling `.css` file (islands cannot use scoped styles) |

Astro pages and React islands cannot share a component, so anything both need
(the empty-state motif, for one) lives as a global utility class.

## Working method

Follow `frontend-design`'s two passes — plan, critique the plan, then build —
but critique against this file too, not only against the brief. Then verify in
the browser rather than asserting: check both themes, check 375px, check
keyboard focus, and confirm no horizontal overflow. The Browser pane tools do
all of this; screenshots are proof, claims are not.

## See also

`vault/Attribution Obligations.md` · `vault/Never Touch the Game.md` ·
`vault/Bugs Worth Remembering.md`
