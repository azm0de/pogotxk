/**
 * POI listing and creation.
 *
 * The admin list deliberately includes non-published rows — the moderation
 * queue lives here — whereas /api/map.json only ever serves `published`.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ApiError, handler, json, readJson, requireRole } from '~/lib/api';
import { recordAudit } from '~/lib/db/audit';
import { uniqueSlugInTable } from '~/lib/slug';

export const prerender = false;

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

  const rows = await env.DB.prepare(
    `SELECT p.id, p.zone_id, p.slug, p.name, p.type, p.description, p.lat, p.lng,
            p.is_campsite, p.is_meetup_spot, p.is_ex_eligible, p.sponsor,
            p.status, p.hero_media_id, p.sort, p.updated_at,
            m.r2_key AS hero_key
       FROM pois p
       LEFT JOIN media m ON m.id = p.hero_media_id
      WHERE (?1 IS NULL OR p.status = ?1)
      ORDER BY p.type, p.name`,
  )
    .bind(status)
    .all();

  return json({ pois: rows.results, count: rows.results.length });
});

export const POST = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const input = await readJson(ctx, poiInput);

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

  const result = await env.DB.prepare(
    `INSERT INTO pois (zone_id, slug, name, type, description, lat, lng,
                       is_campsite, is_meetup_spot, is_ex_eligible, sponsor,
                       status, hero_media_id, sort, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     RETURNING id`,
  )
    .bind(
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
    )
    .first<{ id: number }>();

  if (!result) throw new ApiError(500, 'Insert did not return an id');

  await recordAudit(env.DB, {
    actorId: user.id,
    action: 'create',
    entity: 'poi',
    entityId: result.id,
    diff: { name: input.name, type: input.type, lat: input.lat, lng: input.lng },
  });

  return json({ id: result.id, slug }, 201);
});
