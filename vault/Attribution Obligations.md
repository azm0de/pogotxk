---
tags: [reference, legal]
updated: 2026-08-05
---

# Attribution Obligations

Three separate obligations. None is decorative — each is a condition of using something we do
not own.

## 1. Leek Duck / ScrapedDuck

Raid bosses, eggs, field research and the global event calendar come from
[ScrapedDuck](https://github.com/bigfoott/ScrapedDuck), which scrapes
[LeekDuck.com](https://leekduck.com).

Their terms require, on any page using the data:

- **No paywall**
- **No advertising**
- Visible attribution to **both** ScrapedDuck **and** LeekDuck

Implemented as a shared `Attribution.astro` rendered on `/raids`, `/eggs`, `/research` and
`/events` — deliberately outside the empty-state conditional, so it survives a failed fetch. It
is also carried in the ICS feed's `X-WR-CALDESC` and in the JSON envelope.

> [!warning] This constrains the business model
> Putting ads on the site would breach these terms. If that is ever wanted, the game data has to
> come from somewhere else first.

## 2. Press photographs

Several community photos are **Texarkana Gazette** press photos. Each carries a photographer
byline, article title, date and link — all preserved through the import as first-class columns
on `media`.

Rendered credits sit **on** the image rather than in a caption underneath, so a layout change or
a screenshot cannot separate them.

Photos remain the property of their publications. `/terms` states they come down on request, no
reason needed.

## 3. Nintendo / Niantic / The Pokémon Company

Pokémon and its trademarks are ©1995–2026 Nintendo, Creatures, and GAMEFREAK. Pokémon GO is a
Niantic trademark.

The site is an unofficial fan community. The disclaimer appears in the site footer, `/about`,
`/terms` and `/privacy` — carried over from the old site, which stated the same fair-use
position.

Game-derived marker artwork was **not** ported. The map markers are original SVGs, which also
made them scale and theme properly.

## Map data

© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors and
© [CARTO](https://carto.com/attributions), rendered by Leaflet's own attribution control.

> That control is deliberately not replaced by a custom one in the filter panel — the panel
> collapses, and the attribution must not collapse with it.

## Fonts

Headings (`h1`–`h4`, via `--font-display`) use **Fredoka**, SIL OFL 1.1, self-hosted at
`/fonts/fredoka-700.woff2` — no font CDN, per the project's own constraint. The OFL does not
require on-page credit for ordinary use, only that the license text travel with the font, which
it does at `/fonts/fredoka-OFL.txt`. Body text stays system-ui.

## See also

[[Migration from the Old Site]] · [[Never Touch the Game]]
