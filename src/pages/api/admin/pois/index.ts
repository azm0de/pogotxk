/**
 * POI listing and creation.
 *
 * The admin list deliberately includes non-published rows — the moderation
 * queue lives here — whereas /api/map.json only ever serves `published`.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ApiError, handler, json, readJson, requireRole, requireRowExists } from '~/lib/api';
import { auditStatement } from '~/lib/db/audit';
import { uniqueSlugInTable } from '~/lib/slug';

export const prerender = false;

/**
 * Hard ceiling on one read of the admin list, reported in the response with the
 * true total (admin audit, 2026-10, B-20). The real site has 63 POIs; this is
 * a bound, not a page size.
 */
export const ADMIN_POI_LIST_LIMIT = 1000;

export const poiInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  type: z.enum(['pokestop', 'gym', 'powerspot']),
  description: z.string().trim().max(2000).nullable().optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  isCampsite: z.boolean().optional(),
  isMeetupSpot: z.boolean().optional(),
  isExEligible: z.boolean().optional(),
  sponsor: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['published', 'pending', 'rejected', 'archived']).optional(),
  heroMediaId: z.number().int().positive().nullable().optional(),
  zoneId: z.number().int().positive().optional(),
  sort: z.number().int().optional(),
});

export const GET = handler(async (ctx: APIContext) => {
  requireRole(ctx, 'ambassador');

  const url = new URL(ctx.request.url);
  const status = url.searchParams.get('status');

  const [rows, total] = await env.DB.batch<never>([
    env.DB.prepare(
      `SELECT p.id, p.zone_id, p.slug, p.name, p.type, p.description, p.lat, p.lng,
              p.is_campsite, p.is_meetup_spot, p.is_ex_eligible, p.sponsor,
              p.status, p.hero_media_id, p.sort, p.updated_at,
              m.r2_key AS hero_key
         FROM pois p
         LEFT JOIN media m ON m.id = p.hero_media_id
        WHERE (?1 IS NULL OR p.status = ?1)
        ORDER BY p.type, p.name
        LIMIT ${ADMIN_POI_LIST_LIMIT}`,
    ).bind(status),
    env.DB.prepare('SELECT COUNT(*) AS n FROM pois WHERE (?1 IS NULL OR status = ?1)').bind(status),
  ]);

  const pois = rows.results as unknown[];
  const count = (total.results as unknown as { n: number }[])[0]?.n ?? 0;
  return json({
    pois,
    count: pois.length,
    total: count,
    limit: ADMIN_POI_LIST_LIMIT,
    truncated: count > pois.length,
  });
});

export const POST = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const input = await readJson(ctx, poiInput);

  // Checked before anything is written, so a stale id is a 422 naming the
  // field rather than a foreign-key 500 (admin audit, 2026-10, B-05).
  await requireRowExists(env.DB, 'zones', input.zoneId, 'zoneId');
  await requireRowExists(env.DB, 'media', input.heroMediaId, 'heroMediaId');

  // Default to the default zone so the common case needs no zoneId.
  const zoneId =
    input.zoneId ??
    (
      await env.DB.prepare(
        'SELECT id FROM zones ORDER BY is_default DESC, sort, id LIMIT 1',
      ).first<{ id: number }>()
    )?.id;

  if (!zoneId) throw new ApiError(400, 'No zone exists yet');

  const slug = await uniqueSlugInTable(env.DB, 'pois', input.name);

  // The row and its audit entry in one transaction (admin audit, 2026-10,
  // B-15); the audit row finds the new id by slug, which is unique.
  const [inserted] = await env.DB.batch<{ id: number }>([
    env.DB.prepare(
      `INSERT INTO pois (zone_id, slug, name, type, description, lat, lng,
                         is_campsite, is_meetup_spot, is_ex_eligible, sponsor,
                         status, hero_media_id, sort, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       RETURNING id`,
    ).bind(
      zoneId,
      slug,
      input.name,
      input.type,
      input.description ?? null,
      input.lat,
      input.lng,
      input.isCampsite ? 1 : 0,
      input.isMeetupSpot ? 1 : 0,
      input.isExEligible ? 1 : 0,
      input.sponsor ?? null,
      // Creation is a two-step act: place the pin, then describe it. Defaulting
      // to `pending` keeps a half-finished "New location" off the public map
      // until someone explicitly publishes it.
      input.status ?? 'pending',
      input.heroMediaId ?? null,
      input.sort ?? 0,
      user.id,
    ),
    auditStatement(env.DB, {
      actorId: user.id,
      action: 'create',
      entity: 'poi',
      entityId: { table: 'pois', column: 'slug', value: slug },
      diff: { name: input.name, type: input.type, lat: input.lat, lng: input.lng },
    }),
  ]);

  const id = inserted?.results[0]?.id;
  if (!id) throw new ApiError(500, 'Insert did not return an id');

  return json({ id, slug }, 201);
});
