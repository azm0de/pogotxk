/**
 * Update and remove a single POI.
 *
 * DELETE archives by default — a POI that vanishes from the map because someone
 * mis-clicked should be recoverable. `?hard=1` really deletes, and is reserved
 * for admins.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import {
  ApiError,
  handler,
  intParam,
  json,
  noContent,
  readJson,
  requireRole,
  requireRowExists,
} from '~/lib/api';
import { auditStatement, diffFields } from '~/lib/db/audit';
import { uniqueSlugInTable } from '~/lib/slug';
import { poiInput } from './index';

export const prerender = false;

const patchInput = poiInput.partial();

interface PoiRecord {
  id: number;
  slug: string;
  name: string;
  type: string;
  description: string | null;
  lat: number;
  lng: number;
  is_campsite: number;
  is_meetup_spot: number;
  is_ex_eligible: number;
  sponsor: string | null;
  status: string;
  hero_media_id: number | null;
  sort: number;
}

async function loadPoi(id: number): Promise<PoiRecord> {
  const row = await env.DB.prepare('SELECT * FROM pois WHERE id = ?1').bind(id).first<PoiRecord>();
  if (!row) throw new ApiError(404, 'POI not found');
  return row;
}

export const GET = handler(async (ctx: APIContext) => {
  requireRole(ctx, 'ambassador');
  return json({ poi: await loadPoi(intParam(ctx, 'id')) });
});

export const PATCH = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const id = intParam(ctx, 'id');
  const input = await readJson(ctx, patchInput);
  const before = await loadPoi(id);

  // A stale id is the editor's 422, not a foreign-key 500 (admin audit,
  // 2026-10, B-05). `zoneId` is not in the UPDATE below, so it is checked for
  // the sake of an honest answer rather than for the write.
  await requireRowExists(env.DB, 'zones', input.zoneId, 'zoneId');
  await requireRowExists(env.DB, 'media', input.heroMediaId, 'heroMediaId');

  // Renaming re-slugs, but the old slug keeps working via the id — existing
  // shared links to ?poi=<old-slug> would otherwise break silently. Only
  // regenerate when the name actually changed.
  const slug =
    input.name && input.name !== before.name
      ? await uniqueSlugInTable(env.DB, 'pois', input.name, id)
      : before.slug;

  const next = {
    slug,
    name: input.name ?? before.name,
    type: input.type ?? before.type,
    description: input.description === undefined ? before.description : input.description,
    lat: input.lat ?? before.lat,
    lng: input.lng ?? before.lng,
    is_campsite: input.isCampsite === undefined ? before.is_campsite : input.isCampsite ? 1 : 0,
    is_meetup_spot:
      input.isMeetupSpot === undefined ? before.is_meetup_spot : input.isMeetupSpot ? 1 : 0,
    is_ex_eligible:
      input.isExEligible === undefined ? before.is_ex_eligible : input.isExEligible ? 1 : 0,
    sponsor: input.sponsor === undefined ? before.sponsor : input.sponsor,
    status: input.status ?? before.status,
    hero_media_id: input.heroMediaId === undefined ? before.hero_media_id : input.heroMediaId,
    sort: input.sort ?? before.sort,
  };

  const diff = diffFields(before as unknown as Record<string, unknown>, next);

  // The change and its audit row commit together (admin audit, 2026-10, B-15).
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE pois SET slug = ?2, name = ?3, type = ?4, description = ?5, lat = ?6, lng = ?7,
                       is_campsite = ?8, is_meetup_spot = ?9, is_ex_eligible = ?10, sponsor = ?11,
                       status = ?12, hero_media_id = ?13, sort = ?14,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?1`,
    ).bind(
      id,
      next.slug,
      next.name,
      next.type,
      next.description,
      next.lat,
      next.lng,
      next.is_campsite,
      next.is_meetup_spot,
      next.is_ex_eligible,
      next.sponsor,
      next.status,
      next.hero_media_id,
      next.sort,
    ),
    ...(diff
      ? [auditStatement(env.DB, { actorId: user.id, action: 'update', entity: 'poi', entityId: id, diff })]
      : []),
  ]);

  return json({ id, slug: next.slug, changed: diff !== null });
});

export const DELETE = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const id = intParam(ctx, 'id');
  const hard = new URL(ctx.request.url).searchParams.get('hard') === '1';
  const before = await loadPoi(id);

  const change = hard
    ? env.DB.prepare('DELETE FROM pois WHERE id = ?1').bind(id)
    : env.DB.prepare(
        "UPDATE pois SET status = 'archived', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?1",
      ).bind(id);

  // Irreversible, and it cascades to poi_media — admins only.
  if (hard) requireRole(ctx, 'admin');

  await env.DB.batch([
    change,
    auditStatement(env.DB, {
      actorId: user.id,
      action: hard ? 'delete' : 'archive',
      entity: 'poi',
      entityId: id,
      diff: { name: before.name, type: before.type },
    }),
  ]);

  return noContent();
});
