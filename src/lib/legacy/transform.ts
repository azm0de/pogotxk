/**
 * Maps parsed legacy markers onto the v2 schema.
 *
 * Three decisions the legacy data forces:
 *
 *  1. `assets/ambassador-popup.png` is the Campsite *icon*, not a photo. All 24
 *     markers named "Campsite - *" use it and nothing else does, so it drives
 *     `is_campsite` and never becomes a media row. That takes the real photo
 *     count from 96 down to 72.
 *  2. The legacy `specialgym` type collapses into a gym carrying
 *     `is_meetup_spot`, keeping `pois.type` a clean three-value enum.
 *  3. Names are not unique — "Walk Through History" appears four times across
 *     two types, "Powerspot" four times. Slugs therefore need deterministic
 *     disambiguation, not a bare slugify.
 */

import { AMBASSADOR_ICON, type LegacyMarker } from './parse';

export interface PoiRow {
  slug: string;
  name: string;
  type: 'pokestop' | 'gym' | 'powerspot';
  description: string | null;
  lat: number;
  lng: number;
  isCampsite: boolean;
  isMeetupSpot: boolean;
  /** Legacy asset path, still URL-encoded. Null when there is no real photo. */
  legacyImage: string | null;
}

export interface MediaRow {
  /** Destination key in R2. */
  r2Key: string;
  /** Absolute URL to fetch the original from. */
  sourceUrl: string;
  mime: string;
  alt: string | null;
  caption: string | null;
  credit: string | null;
  sourceTitle: string | null;
  sourceDate: string | null;
  articleUrl: string | null;
  kind: 'photo' | 'community_photo';
  /** Community photos are pinned to the map; POI photos are not. */
  lat: number | null;
  lng: number | null;
}

export interface TransformResult {
  pois: PoiRow[];
  media: MediaRow[];
  /** poi slug -> r2 key, for wiring poi_media and hero_media_id afterwards. */
  poiPhotos: Map<string, string>;
  warnings: string[];
}

export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics: Pokémon -> Pokemon
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

/** Assign `base`, then `base-2`, `base-3`, … tracking what is already taken. */
function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/**
 * Turn `assets/MainCourseHole%238.jpg` into `legacy/main-course-hole-8.jpg`.
 * Legacy filenames contain `#`, `!`, and spaces — legal in R2 but hostile in
 * URLs — so the basename is slugified while the extension is preserved.
 */
export function normalizeMediaKey(legacyPath: string, taken: Set<string>): { key: string; mime: string } {
  const fileName = decodeURIComponent(legacyPath.split('/').pop() ?? 'image');
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = (dot > 0 ? fileName.slice(dot + 1) : 'jpg').toLowerCase();

  const base = `legacy/${slugify(stem)}`;
  let key = `${base}.${ext}`;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}.${ext}`;
  taken.add(key);

  return { key, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' };
}

/**
 * Deterministic ordering so repeated imports assign identical slugs. Sorting by
 * coordinates as the final tiebreak means two POIs with the same name and type
 * always resolve the same way.
 */
function stableOrder(a: LegacyMarker, b: LegacyMarker): number {
  return (
    a.type.localeCompare(b.type) ||
    a.name.localeCompare(b.name) ||
    a.lat - b.lat ||
    a.lng - b.lng
  );
}

export function transform(markers: LegacyMarker[], origin: string): TransformResult {
  const pois: PoiRow[] = [];
  const media: MediaRow[] = [];
  const poiPhotos = new Map<string, string>();
  const warnings: string[] = [];

  const takenSlugs = new Set<string>();
  const takenKeys = new Set<string>();
  /** Legacy path -> r2 key, so a reused photo uploads once. */
  const keyByLegacyPath = new Map<string, string>();

  const absolute = (path: string) => new URL(path, origin).toString();

  const ordered = [...markers].sort(stableOrder);

  for (const m of ordered) {
    if (m.type === 'communityphoto') {
      if (!m.image) {
        warnings.push(`Community photo at ${m.lat},${m.lng} has no image; skipped`);
        continue;
      }
      const { key, mime } = normalizeMediaKey(m.image, takenKeys);
      media.push({
        r2Key: key,
        sourceUrl: absolute(m.image),
        mime,
        alt: m.photoAlt ?? null,
        caption: m.description || null,
        credit: m.credit ?? null,
        sourceTitle: m.sourceTitle ?? null,
        sourceDate: m.sourceDate ?? null,
        articleUrl: m.sourceUrl ?? null,
        kind: 'community_photo',
        lat: m.lat,
        lng: m.lng,
      });
      continue;
    }

    // specialgym collapses into gym; everything else maps straight across.
    const type = m.type === 'specialgym' ? 'gym' : m.type;
    if (type !== 'pokestop' && type !== 'gym' && type !== 'powerspot') {
      warnings.push(`Unknown marker type "${m.type}" for "${m.name}"; skipped`);
      continue;
    }

    const isCampsite = m.image === AMBASSADOR_ICON;
    const isMeetupSpot = m.meetupSpot === true || m.type === 'specialgym';
    const slug = uniqueSlug(slugify(m.name), takenSlugs);

    // The ambassador star is an icon, not a photograph.
    const photo = isCampsite ? null : m.image;

    pois.push({
      slug,
      name: m.name,
      type,
      description: m.description || null,
      lat: m.lat,
      lng: m.lng,
      isCampsite,
      isMeetupSpot,
      legacyImage: photo,
    });

    if (photo) {
      let key = keyByLegacyPath.get(photo);
      if (!key) {
        const normalized = normalizeMediaKey(photo, takenKeys);
        key = normalized.key;
        keyByLegacyPath.set(photo, key);
        media.push({
          r2Key: key,
          sourceUrl: absolute(photo),
          mime: normalized.mime,
          alt: m.photoAlt ?? `${m.name} — ${type}`,
          caption: null,
          credit: m.credit ?? null,
          sourceTitle: m.sourceTitle ?? null,
          sourceDate: m.sourceDate ?? null,
          articleUrl: m.sourceUrl ?? null,
          kind: 'photo',
          lat: null,
          lng: null,
        });
      }
      poiPhotos.set(slug, key);
    }
  }

  return { pois, media, poiPhotos, warnings };
}
