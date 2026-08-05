/**
 * Read model for the public map.
 *
 * One payload holds everything the Leaflet island needs — zone, POIs, overlay
 * shapes, and the community photo pins — so the map renders from a single
 * request instead of a waterfall.
 */

export type PoiType = 'pokestop' | 'gym' | 'powerspot';

export interface MapPhoto {
  /** R2 key; the browser fetches it from `/media/<key>`. */
  key: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  credit: string | null;
  sourceTitle: string | null;
  sourceDate: string | null;
  sourceUrl: string | null;
}

export interface MapPoi {
  id: number;
  slug: string;
  name: string;
  type: PoiType;
  description: string | null;
  lat: number;
  lng: number;
  isCampsite: boolean;
  isMeetupSpot: boolean;
  isExEligible: boolean;
  photo: MapPhoto | null;
}

export interface MapShape {
  slug: string;
  name: string;
  kind: 'route' | 'polygon' | 'circle';
  geojson: unknown;
  style: Record<string, unknown> | null;
  visibleByDefault: boolean;
}

export interface MapZone {
  slug: string;
  name: string;
  blurb: string | null;
  center: [number, number];
  zoom: number;
  bounds: [[number, number], [number, number]] | null;
}

export interface MapData {
  zone: MapZone;
  pois: MapPoi[];
  shapes: MapShape[];
  communityPhotos: (MapPhoto & { lat: number; lng: number; caption: string | null })[];
  counts: Record<PoiType, number>;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function getMapData(db: D1Database, zoneSlug?: string): Promise<MapData | null> {
  const zoneRow = await db
    .prepare(
      zoneSlug
        ? 'SELECT * FROM zones WHERE slug = ?1'
        : 'SELECT * FROM zones ORDER BY is_default DESC, sort, id LIMIT 1',
    )
    .bind(...(zoneSlug ? [zoneSlug] : []))
    .first<{
      id: number;
      slug: string;
      name: string;
      blurb: string | null;
      center_lat: number;
      center_lng: number;
      default_zoom: number;
      bounds_json: string | null;
    }>();

  if (!zoneRow) return null;

  const [poiRes, shapeRes, photoRes] = await db.batch<never>([
    db
      .prepare(
        `SELECT p.id, p.slug, p.name, p.type, p.description, p.lat, p.lng,
                p.is_campsite, p.is_meetup_spot, p.is_ex_eligible,
                m.r2_key, m.alt, m.width, m.height, m.credit,
                m.source_title, m.source_date, m.source_url
           FROM pois p
           LEFT JOIN media m ON m.id = p.hero_media_id
          WHERE p.zone_id = ?1 AND p.status = 'published'
          ORDER BY p.type, p.name`,
      )
      .bind(zoneRow.id),
    db
      .prepare(
        `SELECT slug, name, kind, geojson, style_json, visible_by_default
           FROM map_shapes WHERE zone_id = ?1 ORDER BY sort, id`,
      )
      .bind(zoneRow.id),
    db
      .prepare(
        `SELECT r2_key, alt, width, height, credit, source_title, source_date, source_url,
                caption, lat, lng
           FROM media
          WHERE kind = 'community_photo' AND zone_id = ?1 AND lat IS NOT NULL
          ORDER BY created_at`,
      )
      .bind(zoneRow.id),
  ]);

  const counts: Record<PoiType, number> = { pokestop: 0, gym: 0, powerspot: 0 };

  const pois = (poiRes.results as unknown[] as Record<string, never>[]).map((r): MapPoi => {
    const row = r as unknown as {
      id: number;
      slug: string;
      name: string;
      type: PoiType;
      description: string | null;
      lat: number;
      lng: number;
      is_campsite: number;
      is_meetup_spot: number;
      is_ex_eligible: number;
      r2_key: string | null;
      alt: string | null;
      width: number | null;
      height: number | null;
      credit: string | null;
      source_title: string | null;
      source_date: string | null;
      source_url: string | null;
    };

    counts[row.type] = (counts[row.type] ?? 0) + 1;

    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      type: row.type,
      description: row.description,
      lat: row.lat,
      lng: row.lng,
      isCampsite: row.is_campsite === 1,
      isMeetupSpot: row.is_meetup_spot === 1,
      isExEligible: row.is_ex_eligible === 1,
      photo: row.r2_key
        ? {
            key: row.r2_key,
            alt: row.alt,
            width: row.width,
            height: row.height,
            credit: row.credit,
            sourceTitle: row.source_title,
            sourceDate: row.source_date,
            sourceUrl: row.source_url,
          }
        : null,
    };
  });

  const shapes = (shapeRes.results as unknown[] as Record<string, never>[]).map((r): MapShape => {
    const row = r as unknown as {
      slug: string;
      name: string;
      kind: MapShape['kind'];
      geojson: string;
      style_json: string | null;
      visible_by_default: number;
    };
    return {
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      geojson: parseJson<unknown>(row.geojson, null),
      style: parseJson<Record<string, unknown> | null>(row.style_json, null),
      visibleByDefault: row.visible_by_default === 1,
    };
  });

  const communityPhotos = (photoRes.results as unknown[] as Record<string, never>[]).map((r) => {
    const row = r as unknown as {
      r2_key: string;
      alt: string | null;
      width: number | null;
      height: number | null;
      credit: string | null;
      source_title: string | null;
      source_date: string | null;
      source_url: string | null;
      caption: string | null;
      lat: number;
      lng: number;
    };
    return {
      key: row.r2_key,
      alt: row.alt,
      width: row.width,
      height: row.height,
      credit: row.credit,
      sourceTitle: row.source_title,
      sourceDate: row.source_date,
      sourceUrl: row.source_url,
      caption: row.caption,
      lat: row.lat,
      lng: row.lng,
    };
  });

  return {
    zone: {
      slug: zoneRow.slug,
      name: zoneRow.name,
      blurb: zoneRow.blurb,
      center: [zoneRow.center_lat, zoneRow.center_lng],
      zoom: zoneRow.default_zoom,
      bounds: parseJson<MapZone['bounds']>(zoneRow.bounds_json, null),
    },
    pois,
    shapes,
    communityPhotos,
    counts,
  };
}
