---
tags: [architecture, map]
updated: 2026-08-28
---

# Basemap

The map's tiles are **our own**, not a third party's. Protomaps vector tiles over
OpenStreetMap data, extracted for the Texarkana area, stored in R2, and rendered
in the browser by `protomaps-leaflet`. Built in
[[basemap.ts|src/components/map/basemap.ts]] and used by both the public map
(`MapView`) and the admin editor (`MapEditor`) through one shared factory, so the
two cannot drift.

## Why self-hosted

It used to be keyless **CARTO Voyager** (`basemaps.cartocdn.com`). CARTO began
stamping **"API KEY REQUIRED"** across those tiles once the site saw real
traffic — fully in a fresh context, and as a watermark over the live map. The
keyless tier is not a production surface. The choices were a keyed third-party
tier (back to leaning on someone's free allowance) or hosting our own; we host
our own, which matches the self-hosted fonts and art already here — no key to
leak, no rate limit, no watermark, ever.

## How it is served

The `.pmtiles` archive is one static file. `protomaps-leaflet` reads it with HTTP
**range requests**, so it only ever pulls the few tiles on screen — never the
whole file. That means the host has to answer `206 Partial Content`, and
**[[Media serving|src/pages/media/[...key].ts]] already does** — it was built to
serve ranged video for iOS. So the basemap rides the existing `/media/` route out
of the existing `MEDIA` R2 bucket, same-origin, with **no new binding, bucket,
route, or CORS**. The object key is `basemap/texarkana.pmtiles`.

> [!note] The `light` flavor is pinned in both themes
> The basemap is *content* — people match it against every other street map they
> have seen — so it does not follow `prefers-color-scheme`. A dark basemap read
> as the map being broken, not as dark mode. Same reasoning that pinned Voyager
> light before. Protomaps flavors: `light` | `dark` | `white` | `grayscale` |
> `black`; `light` is the closest match to the old Voyager look.

## Attribution is an obligation

OpenStreetMap **and** Protomaps must both stay credited — it is baked into the
layer's `attribution` in `basemap.ts` and shows in Leaflet's own control. Do not
remove it. See [[Attribution Obligations]].

## Refreshing the tiles

The extract is a point-in-time copy of OSM (built 2026-08-27). It does not need
refreshing often — the park's streets do not move — but to update it:

1. Get the [go-pmtiles](https://github.com/protomaps/go-pmtiles) CLI.
2. Range-extract the Texarkana metro box from Protomaps' public daily planet
   build (pulls ~2.4 MB, not the 137 GB):
   ```
   pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles texarkana.pmtiles \
     --bbox=-94.15,33.38,-93.95,33.52
   ```
   The box is W −94.15, S 33.38, E −93.95, N 33.52 — both Texarkanas plus margin,
   z0–15. The renderer over-zooms past z15 by scaling, so the park stays legible
   to the map's `maxZoom` of 20.
3. Upload to **production** R2 (inert until the object key is what the code
   requests — same key overwrites in place):
   ```
   wrangler r2 object put pogotxk-media/basemap/texarkana.pmtiles \
     --file=texarkana.pmtiles --content-type=application/octet-stream --remote
   ```

> [!warning] Local dev cannot see the R2 basemap
> `astro dev`'s bundled Miniflare uses an **older local-R2 format** than the
> `wrangler` CLI, so `wrangler r2 object put --local` writes a store the dev
> server does not read — the tiles 404 in dev and the map shows its bare
> `--map-canvas` ground (pins, filters and popups still work). To eyeball the
> basemap locally, drop the file in `public/basemap/` and point `BASEMAP_URL` at
> `/basemap/texarkana.pmtiles` for the test only — Vite serves ranges in dev.
> **Not** a production path: the Cloudflare static-asset layer does not serve
> ranges (the whole reason the `/media` route exists).

## See also

[[Configuration]] · [[Platform Limits and Traps]] · [[Attribution Obligations]]
