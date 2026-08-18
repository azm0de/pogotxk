# Source art

Originals. Nothing here is served — that is the entire point of the directory.

The site's artwork is delivered as responsive derivatives under `public/hero/`
and `public/art/`, generated from the files kept here. Keeping the originals in
the repo means a different crop or a wider size can be regenerated later without
hunting for where an image came from.

## Why they are not in `public/`

Everything under `public/` is copied verbatim into the build and uploaded as a
static asset, whether or not a single line of code references it. These ten
files were sitting there unreferenced, and production answered `200` for all of
them — 9.1 MB of the 9.3 MB in `public/art/`, downloadable by anyone who guessed
a filename, loaded by no page.

That was not deliberate. They were untracked working files that a deploy picked
up anyway; committing them in `7791fec` made the repo match production without
changing the fact that production should never have been serving them.

> [!warning] `public/` is a publishing decision, not a storage location
> Putting a file there publishes it. If a file is source material rather than
> something a page loads, it belongs here instead.

## The Pokémon GO logo

`Pokemon_Go.svg.webp` is the official Pokémon GO wordmark. It was the reference
used to generate the site's own logo, and that work is done.

**It must not be used in the site, and it must not be served.** The project rule
is explicit — see `vault/Attribution Obligations.md` §3 and the `pogotxk-design`
skill: the site is unofficial fan work, game-derived artwork is not ported, and
this logo in particular is Justin's own call. It was reachable at
`/art/Pokemon_Go.svg.webp` in production until 2026-08-18.

It is kept here only as the record of what the logo was derived from. Deleting
it outright is Justin's call, not the repo's — note that it remains in git
history from `7791fec` regardless, so removing the file now would not unpublish
it from GitHub.

## What derives from what

| Source | Derivatives |
|---|---|
| `pokestop.jpg` | `public/hero/pokestop-{640,960,1280}.webp` |
| `pokemon-outing.jpg` | `public/hero/outing-{640,960,1280}.webp` |
| `pokemon-go-battle-wartortle.jpg` | `public/hero/raid-battle-{640,960,1280,1600}.webp` |
| `Mew_800x.webp`, `mim.gif` | `public/art/mew-{anim,still}.webp` |
| `mgkp.gif` | `public/art/magikarp-{anim,still}.webp` |

`go.webp`, `pogoeve.png` and `pogo10.jpg` have no derivative in the tree and no
page uses them. They are Justin's staging material, kept as found.

## See also

`vault/Attribution Obligations.md` · `vault/Design System.md`
