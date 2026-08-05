/**
 * Parsers for the legacy pokemontxk.com data files.
 *
 * The old site stores everything as literal JavaScript that the browser eval'd
 * via <script> tags. We re-parse it here without eval: locate the literal's
 * bracket span and JSON.parse it where the syntax allows, and fall back to
 * targeted regex where it doesn't (meetup.js uses unquoted keys).
 *
 * These functions are pure — no bindings, no fetch — so they can be exercised
 * against fixtures.
 */

/** The ambassador star used as the popup icon for Campsite POIs. Not a photo. */
export const AMBASSADOR_ICON = 'assets/ambassador-popup.png';

export type LegacyType = 'pokestop' | 'gym' | 'powerspot' | 'specialgym' | 'communityphoto';

export interface LegacyMarker {
  name: string;
  type: LegacyType;
  description: string;
  image: string | null;
  lat: number;
  lng: number;
  /** Community photo extras. */
  photoAlt?: string;
  credit?: string;
  sourceTitle?: string;
  sourceDate?: string;
  sourceUrl?: string;
  meetupSpot?: boolean;
}

export interface LegacyMeetup {
  title: string;
  date: string;
  time: string;
  location: string;
  description: string;
}

export type LatLng = [number, number];

/**
 * Extract the balanced bracket span starting at the first `open` at or after
 * `from`. Counts depth while skipping over string literals, so coordinates or
 * names containing brackets cannot terminate the span early.
 */
function extractBracketSpan(src: string, from: number, open: '[' | '{'): string {
  const close = open === '[' ? ']' : '}';
  const start = src.indexOf(open, from);
  if (start === -1) throw new Error(`No "${open}" found after index ${from}`);

  let depth = 0;
  let inString: '"' | "'" | null = null;
  let escaped = false;

  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }

    if (ch === '"' || ch === "'") inString = ch;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }

  throw new Error(`Unbalanced "${open}" starting at index ${start}`);
}

/** Parse `window.markers = [ ... ];` from markers.js. */
export function parseMarkers(source: string): LegacyMarker[] {
  const anchor = source.indexOf('window.markers');
  if (anchor === -1) throw new Error('markers.js: no `window.markers` assignment found');

  const parsed: unknown = JSON.parse(extractBracketSpan(source, anchor, '['));
  if (!Array.isArray(parsed)) throw new Error('markers.js: literal is not an array');

  return parsed.map((raw, i) => {
    const m = raw as Record<string, unknown>;
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    const type = m.type as LegacyType;
    const lat = Number(m.lat);
    const lng = Number(m.lng);

    if (!name) throw new Error(`markers.js: entry ${i} has no name`);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error(`markers.js: entry ${i} (${name}) has non-numeric coordinates`);
    }

    const marker: LegacyMarker = {
      name,
      type,
      description: typeof m.description === 'string' ? m.description.trim() : '',
      image: typeof m.image === 'string' && m.image ? m.image : null,
      lat,
      lng,
    };

    // Copy the optional attribution fields through verbatim — the Texarkana
    // Gazette photos carry a byline and article link we must not drop.
    for (const key of ['photoAlt', 'credit', 'sourceTitle', 'sourceDate', 'sourceUrl'] as const) {
      const v = m[key];
      if (typeof v === 'string' && v.trim()) marker[key] = v.trim();
    }
    if (m.meetupSpot === true) marker.meetupSpot = true;

    return marker;
  });
}

/**
 * Parse `window.nextMeetup = { title: "...", ... };` from meetup.js.
 *
 * The keys are unquoted, so this is not valid JSON — pull each known field out
 * individually rather than trying to coerce the whole literal.
 */
export function parseMeetup(source: string): LegacyMeetup {
  const anchor = source.indexOf('window.nextMeetup');
  if (anchor === -1) throw new Error('meetup.js: no `window.nextMeetup` assignment found');

  const literal = extractBracketSpan(source, anchor, '{');
  const field = (key: string): string => {
    // Tolerates single or double quotes and escaped quotes inside the value.
    const re = new RegExp(`\\b${key}\\s*:\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`, 's');
    const hit = literal.match(re);
    return hit?.[2]?.replace(/\\(['"\\])/g, '$1').trim() ?? '';
  };

  const meetup: LegacyMeetup = {
    title: field('title'),
    date: field('date'),
    time: field('time'),
    location: field('location'),
    description: field('description'),
  };

  if (!meetup.title) throw new Error('meetup.js: could not read `title`');
  return meetup;
}

/** Pull a `const <name> = [[lat,lng], ...]` coordinate array out of script.js. */
export function parseCoordArray(source: string, varName: string): LatLng[] {
  const anchor = source.search(new RegExp(`\\b${varName}\\b\\s*=`));
  if (anchor === -1) throw new Error(`script.js: no \`${varName}\` assignment found`);

  const parsed: unknown = JSON.parse(extractBracketSpan(source, anchor, '['));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`script.js: \`${varName}\` is not a non-empty array`);
  }

  return parsed.map((pair, i) => {
    if (!Array.isArray(pair) || pair.length < 2) {
      throw new Error(`script.js: ${varName}[${i}] is not a [lat, lng] pair`);
    }
    const lat = Number(pair[0]);
    const lng = Number(pair[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error(`script.js: ${varName}[${i}] has non-numeric coordinates`);
    }
    return [lat, lng] as LatLng;
  });
}

/**
 * Convert `[lat, lng]` pairs to GeoJSON, which uses `[lng, lat]` order.
 * Getting this backwards puts Spring Lake Park in Antarctica, so it lives in
 * one place.
 */
export function toGeoJsonLineString(coords: LatLng[]): string {
  return JSON.stringify({
    type: 'LineString',
    coordinates: coords.map(([lat, lng]) => [lng, lat]),
  });
}

export function toGeoJsonPolygon(coords: LatLng[]): string {
  const ring = coords.map(([lat, lng]) => [lng, lat]);
  // GeoJSON polygons must close explicitly.
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);

  return JSON.stringify({ type: 'Polygon', coordinates: [ring] });
}
