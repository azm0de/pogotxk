/**
 * The shared basemap layer, used by both the public map (MapView) and the admin
 * editor (MapEditor) so the two can never drift apart.
 *
 * The tiles are our own — Protomaps vector tiles over OpenStreetMap data —
 * served from R2 through the range-capable /media route (see
 * src/pages/media/[...key].ts, which already answers the HTTP 206s pmtiles
 * needs). Self-hosted rather than a third-party tile endpoint, so there is no
 * API key to leak, no rate limit, and no watermark: CARTO began stamping
 * "API KEY REQUIRED" across the keyless Voyager tiles it used to serve here once
 * the site saw real traffic.
 *
 * The `light` theme is pinned in both themes on purpose. The basemap is
 * *content* — people match it against every other street map they have seen — so
 * it does not follow `prefers-color-scheme` the way the site's own chrome does;
 * a dark basemap read as the map being broken, not as dark mode.
 */

import { leafletLayer } from 'protomaps-leaflet';

/** R2 object key path, served same-origin so no CORS handling is needed. */
export const BASEMAP_URL = '/media/basemap/texarkana.pmtiles';

/**
 * A fresh light basemap layer. Each map needs its own instance — a Leaflet
 * layer belongs to one map at a time — so this is a factory, not a singleton.
 * The vector tiles over-zoom past their own z15 data by scaling, so the park
 * stays legible up to the map's maxZoom.
 */
export function basemapLayer() {
  return leafletLayer({
    url: BASEMAP_URL,
    // Protomaps' built-in flavors are light | dark | white | grayscale | black;
    // `light` is the closest match to the Voyager look this map carried before.
    flavor: 'light',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://protomaps.com">Protomaps</a>',
  });
}
