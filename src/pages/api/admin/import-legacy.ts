/**
 * One-shot import of the legacy pokemontxk.com data into D1.
 *
 * Metadata only — POIs, media *rows*, map shapes, the meetup, and the zone.
 * The 63 POI photographs and 9 community photos are fetched separately by
 * `/api/admin/import-media`, because a Worker on the free plan may only make 50
 * subrequests per request and this pass needs just three.
 *
 *   curl -X POST http://localhost:4321/api/admin/import-legacy \
 *        -H "Authorization: Bearer $IMPORT_TOKEN"
 *
 * Idempotent: refuses to run against a populated database unless `?force=1`,
 * which clears the imported tables first.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { json, requireImportToken } from '~/lib/admin-auth';
import {
  parseCoordArray,
  parseMarkers,
  parseMeetup,
  toGeoJsonLineString,
  toGeoJsonPolygon,
} from '~/lib/legacy/parse';
import { transform } from '~/lib/legacy/transform';

export const prerender = false;

const ORIGIN = 'https://pokemontxk.com';
const ZONE_SLUG = 'spring-lake-park';

/** D1 caps a batch at 100 statements; stay well under. */
const BATCH_SIZE = 50;

async function fetchText(path: string): Promise<string> {
  const res = await fetch(new URL(path, ORIGIN), {
    headers: { 'user-agent': 'pogotxk-import/1.0 (+https://pokemontxk.com)' },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.text();
}

async function runBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

export async function POST(ctx: APIContext): Promise<Response> {
  const denied = requireImportToken(ctx.request, env);
  if (denied) return denied;

  const db = env.DB;
  const force = new URL(ctx.request.url).searchParams.get('force') === '1';

  try {
    const existing = await db.prepare('SELECT COUNT(*) AS n FROM pois').first<{ n: number }>();
    if ((existing?.n ?? 0) > 0 && !force) {
      return json(
        {
          error: 'Database already contains POIs.',
          pois: existing?.n,
          hint: 'Re-run with ?force=1 to clear the imported tables and start over.',
        },
        409,
      );
    }

    // --- fetch (3 subrequests) -------------------------------------------
    const [markersJs, scriptJs, meetupJs] = await Promise.all([
      fetchText('/markers.js'),
      fetchText('/script.js'),
      fetchText('/meetup.js'),
    ]);

    const markers = parseMarkers(markersJs);
    const { pois, media, poiPhotos, warnings } = transform(markers, ORIGIN);
    const hotspot = parseCoordArray(scriptJs, 'hotspotBoundary');
    const raidRoute = parseCoordArray(scriptJs, 'raidRouteCoordinates');
    const meetup = parseMeetup(meetupJs);

    if (pois.length === 0) throw new Error('Parsed zero POIs — refusing to write.');

    // --- reset ------------------------------------------------------------
    if (force) {
      // Order matters: children before parents. poi_media, poi photos and
      // map_shapes all cascade from pois/zones, but being explicit keeps this
      // readable and independent of cascade config.
      await runBatched(db, [
        db.prepare('DELETE FROM poi_media'),
        db.prepare('DELETE FROM map_shapes'),
        db.prepare('DELETE FROM meetups'),
        db.prepare('DELETE FROM pois'),
        db.prepare("DELETE FROM media WHERE kind IN ('photo', 'community_photo')"),
        db.prepare('DELETE FROM zones WHERE slug = ?').bind(ZONE_SLUG),
      ]);
    }

    // --- zone -------------------------------------------------------------
    // Derived from the data rather than hardcoded, so re-importing a widened
    // POI set re-centres the map automatically.
    const lats = pois.map((p) => p.lat);
    const lngs = pois.map((p) => p.lng);
    const bounds = [
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)],
    ];
    const centerLat = (bounds[0]![0]! + bounds[1]![0]!) / 2;
    const centerLng = (bounds[0]![1]! + bounds[1]![1]!) / 2;

    await db
      .prepare(
        `INSERT INTO zones (slug, name, blurb, center_lat, center_lng, default_zoom, bounds_json, is_default, sort)
         VALUES (?1, ?2, ?3, ?4, ?5, 16, ?6, 1, 0)
         ON CONFLICT (slug) DO UPDATE SET
           center_lat = excluded.center_lat,
           center_lng = excluded.center_lng,
           bounds_json = excluded.bounds_json,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
      )
      .bind(
        ZONE_SLUG,
        'Spring Lake Park',
        'The PoGo TXK Community Campsite in Texarkana, Texas.',
        centerLat,
        centerLng,
        JSON.stringify(bounds),
      )
      .run();

    const zone = await db
      .prepare('SELECT id FROM zones WHERE slug = ?')
      .bind(ZONE_SLUG)
      .first<{ id: number }>();
    if (!zone) throw new Error('Zone insert did not produce a row');
    const zoneId = zone.id;

    // --- media rows -------------------------------------------------------
    // Bytes land in R2 later via /api/admin/import-media. Rows go in now so
    // POIs can reference them.
    await runBatched(
      db,
      media.map((m) =>
        db
          .prepare(
            `INSERT INTO media (r2_key, mime, alt, caption, credit, source_title, source_date, source_url, kind, zone_id, lat, lng)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT (r2_key) DO UPDATE SET
               alt = excluded.alt, caption = excluded.caption, credit = excluded.credit,
               source_title = excluded.source_title, source_date = excluded.source_date,
               source_url = excluded.source_url`,
          )
          .bind(
            m.r2Key,
            m.mime,
            m.alt,
            m.caption,
            m.credit,
            m.sourceTitle,
            m.sourceDate,
            m.articleUrl,
            m.kind,
            m.kind === 'community_photo' ? zoneId : null,
            m.lat,
            m.lng,
          ),
      ),
    );

    const mediaIdByKey = new Map<string, number>();
    for (const row of (
      await db.prepare('SELECT id, r2_key FROM media').all<{ id: number; r2_key: string }>()
    ).results) {
      mediaIdByKey.set(row.r2_key, row.id);
    }

    // --- POIs -------------------------------------------------------------
    await runBatched(
      db,
      pois.map((p) => {
        const key = poiPhotos.get(p.slug);
        const heroId = key ? (mediaIdByKey.get(key) ?? null) : null;
        return db
          .prepare(
            `INSERT INTO pois (zone_id, slug, name, type, description, lat, lng, is_campsite, is_meetup_spot, hero_media_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (slug) DO UPDATE SET
               name = excluded.name, type = excluded.type, description = excluded.description,
               lat = excluded.lat, lng = excluded.lng, is_campsite = excluded.is_campsite,
               is_meetup_spot = excluded.is_meetup_spot, hero_media_id = excluded.hero_media_id,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
          )
          .bind(
            zoneId,
            p.slug,
            p.name,
            p.type,
            p.description,
            p.lat,
            p.lng,
            p.isCampsite ? 1 : 0,
            p.isMeetupSpot ? 1 : 0,
            heroId,
          );
      }),
    );

    const poiIdBySlug = new Map<string, number>();
    for (const row of (
      await db.prepare('SELECT id, slug FROM pois').all<{ id: number; slug: string }>()
    ).results) {
      poiIdBySlug.set(row.slug, row.id);
    }

    // --- poi_media --------------------------------------------------------
    const links: D1PreparedStatement[] = [];
    for (const [slug, key] of poiPhotos) {
      const poiId = poiIdBySlug.get(slug);
      const mediaId = mediaIdByKey.get(key);
      if (poiId && mediaId) {
        links.push(
          db
            .prepare(
              'INSERT INTO poi_media (poi_id, media_id, sort) VALUES (?1, ?2, 0) ON CONFLICT DO NOTHING',
            )
            .bind(poiId, mediaId),
        );
      }
    }
    await runBatched(db, links);

    // --- map shapes -------------------------------------------------------
    await runBatched(db, [
      db
        .prepare(
          `INSERT INTO map_shapes (zone_id, slug, name, kind, geojson, style_json, visible_by_default, sort)
           VALUES (?1, 'raid-route', 'Raid Route', 'route', ?2, ?3, 0, 0)
           ON CONFLICT (zone_id, slug) DO UPDATE SET geojson = excluded.geojson`,
        )
        .bind(
          zoneId,
          toGeoJsonLineString(raidRoute),
          JSON.stringify({ color: '#f2a33c', weight: 5, opacity: 0.9, dashArray: '1 10' }),
        ),
      db
        .prepare(
          `INSERT INTO map_shapes (zone_id, slug, name, kind, geojson, style_json, visible_by_default, sort)
           VALUES (?1, 'hotspot', 'Hotspot', 'polygon', ?2, ?3, 0, 1)
           ON CONFLICT (zone_id, slug) DO UPDATE SET geojson = excluded.geojson`,
        )
        .bind(
          zoneId,
          toGeoJsonPolygon(hotspot),
          JSON.stringify({ color: '#7b5cff', weight: 2, fillOpacity: 0.15 }),
        ),
    ]);

    // --- meetup -----------------------------------------------------------
    // The legacy record stores prose ("Wednesday August 5th", "6 PM - 7 PM CST")
    // rather than a timestamp, so it is preserved verbatim in location_text and
    // description and left as a draft for an admin to date properly.
    const meetupPoiId = poiIdBySlug.get('campsite-genuine') ?? null;
    await db
      .prepare(
        `INSERT INTO meetups (zone_id, slug, title, description_md, starts_at, tz, poi_id, location_text, status)
         VALUES (?1, 'imported-next-meetup', ?2, ?3, ?4, 'America/Chicago', ?5, ?6, 'draft')
         ON CONFLICT (slug) DO UPDATE SET
           title = excluded.title, description_md = excluded.description_md,
           location_text = excluded.location_text,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
      )
      .bind(
        zoneId,
        meetup.title,
        [meetup.description, '', `_Imported from meetup.js: ${meetup.date}, ${meetup.time}._`]
          .join('\n')
          .trim(),
        new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        meetupPoiId,
        meetup.location,
      )
      .run();

    const pendingMedia = media.length;

    return json({
      ok: true,
      zone: { id: zoneId, slug: ZONE_SLUG, center: [centerLat, centerLng], bounds },
      pois: {
        total: pois.length,
        byType: pois.reduce<Record<string, number>>((acc, p) => {
          acc[p.type] = (acc[p.type] ?? 0) + 1;
          return acc;
        }, {}),
        campsite: pois.filter((p) => p.isCampsite).length,
        meetupSpot: pois.filter((p) => p.isMeetupSpot).length,
      },
      media: {
        rows: pendingMedia,
        photos: media.filter((m) => m.kind === 'photo').length,
        communityPhotos: media.filter((m) => m.kind === 'community_photo').length,
        withCredit: media.filter((m) => m.credit).length,
      },
      shapes: { raidRoutePoints: raidRoute.length, hotspotPoints: hotspot.length },
      meetup: { title: meetup.title, status: 'draft', needsRealDate: true },
      warnings,
      next: 'POST /api/admin/import-media?limit=30 repeatedly until remaining is 0.',
    });
  } catch (err) {
    return json(
      { error: 'Import failed', detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
