/**
 * Marker artwork for the map.
 *
 * Drawn as inline SVG rather than the legacy PNG sprites: it stays sharp on
 * retina, recolours for dark mode, and each type gets a distinct *silhouette*
 * as well as a distinct hue, so the map is still readable in greyscale or with
 * colour-vision deficiency.
 */

import L from 'leaflet';
import type { PoiType } from '~/lib/db/map';

/** Teardrop pin body. The glyph sits in the round head at 16,15 (r≈8). */
function pin(glyph: string): string {
  return `<svg viewBox="0 0 32 44" width="32" height="44" aria-hidden="true" focusable="false">
    <path class="pin-body" d="M16 43C16 43 30 26.5 30 16A14 14 0 1 0 2 16C2 26.5 16 43 16 43Z"/>
    <circle class="pin-head" cx="16" cy="15.5" r="8.4"/>
    ${glyph}
  </svg>`;
}

/** PokéStop — the classic cube-on-a-post, reduced to a diamond. */
const GLYPH_POKESTOP = `<path class="pin-glyph" d="M16 9.6l5.2 5.9-5.2 5.9-5.2-5.9z"/>`;

/** Gym — a tower silhouette. */
const GLYPH_GYM = `<path class="pin-glyph" d="M11.4 20.6v-7.1l4.6-3.6 4.6 3.6v7.1h-3.1v-4.1h-3v4.1z"/>`;

/** Power Spot — a hexagon, echoing Max/Dynamax framing. */
const GLYPH_POWERSPOT = `<path class="pin-glyph" d="M16 9.4l5 2.9v5.8l-5 2.9-5-2.9v-5.8z"/>`;

const GLYPHS: Record<PoiType, string> = {
  pokestop: GLYPH_POKESTOP,
  gym: GLYPH_GYM,
  powerspot: GLYPH_POWERSPOT,
};

/** Ambassador star, badged onto Campsite POIs. */
const CAMPSITE_BADGE = `<span class="pin-badge" aria-hidden="true">
  <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
    <path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/>
  </svg>
</span>`;

/**
 * Escapes text before it goes into a divIcon's `html` string.
 *
 * These are location names out of the database, so `&` in "Boy Scouts & Co" is
 * enough to break the markup — and the same hole would take a `<script>`.
 */
function esc(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

export interface PinOptions {
  type: PoiType;
  isCampsite: boolean;
  isMeetupSpot: boolean;
  /** Renders the pin larger and pulsing — used for an active flare. */
  isLive?: boolean;
  /**
   * The pin's accessible name.
   *
   * Leaflet gives every keyboard-enabled marker `role="button"` and
   * `tabindex="0"`, and a `divIcon` gives it nothing to be called — so every pin
   * on the map was an unnamed button. Marker options do not help: `alt` is only
   * written onto an `<img>` icon, which this is not. The name has to be inside
   * the HTML.
   */
  label?: string;
}

export function poiIcon({ type, isCampsite, isMeetupSpot, isLive, label }: PinOptions): L.DivIcon {
  const classes = [
    'pin',
    `pin--${type}`,
    isCampsite ? 'pin--campsite' : '',
    isMeetupSpot ? 'pin--meetup' : '',
    isLive ? 'pin--live' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return L.divIcon({
    className: 'pin-wrap',
    html: `<span class="${classes}">${pin(GLYPHS[type])}${isCampsite ? CAMPSITE_BADGE : ''}</span>${
      label ? `<span class="sr-only">${esc(label)}</span>` : ''
    }`,
    iconSize: [32, 44],
    // Anchor at the point of the teardrop so the pin sits on its coordinate.
    iconAnchor: [16, 43],
    popupAnchor: [0, -38],
  });
}

/** Community photo pins read as photographs, not game locations. */
export function photoIcon(label?: string): L.DivIcon {
  return L.divIcon({
    className: 'pin-wrap',
    html: `<span class="pin pin--photo">
      <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" focusable="false">
        <rect class="pin-body" x="1.5" y="4.5" width="29" height="23" rx="5"/>
        <circle class="pin-head" cx="16" cy="16" r="6.2"/>
        <circle class="pin-glyph" cx="16" cy="16" r="2.8"/>
      </svg>
    </span>${label ? `<span class="sr-only">${esc(label)}</span>` : ''}`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14],
  });
}

/** "You are here" — a pulsing dot, visually unlike any POI pin. */
export function userIcon(): L.DivIcon {
  return L.divIcon({
    className: 'pin-wrap',
    html: `<span class="user-dot" aria-hidden="true"><span class="user-dot-pulse"></span></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

export const TYPE_LABEL: Record<PoiType, string> = {
  pokestop: 'PokéStop',
  gym: 'Gym',
  powerspot: 'Power Spot',
};
