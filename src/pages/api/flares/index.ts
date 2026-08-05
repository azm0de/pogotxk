/**
 * The live board's read and write endpoints.
 *
 *   GET  /api/flares   active flares (public)
 *   POST /api/flares   raise one (requires `member`)
 *
 * The GET is also the client's fallback when the WebSocket cannot connect, so
 * it returns a complete snapshot rather than a delta, and carries the server
 * clock so a client with a skewed device clock still counts flares down
 * correctly.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ApiError, handler, json, readJson, requireRole } from '~/lib/api';
import {
  expiryFor,
  FLARE_KINDS,
  getFlare,
  getViewerRsvps,
  hasDuplicateFlare,
  isoNow,
  listActiveFlares,
  MAX_TTL_MINUTES,
  MIN_TTL_MINUTES,
} from '~/lib/db/flares';
import { notifyLiveBoard } from '~/do/LiveBoard';

export const prerender = false;

export const flareInput = z.object({
  kind: z.enum(FLARE_KINDS),
  poiId: z.number().int().positive().nullable().optional(),
  /** Free text, matched against the boss list at post time — never an id. */
  boss: z.string().trim().max(80).nullable().optional(),
  tier: z.string().trim().max(24).nullable().optional(),
  /** How many more trainers are wanted, for remote_invites. */
  needed: z.number().int().min(1).max(20).nullable().optional(),
  note: z.string().trim().max(280).nullable().optional(),
  /** Override the per-kind default lifetime. */
  minutes: z.number().int().min(MIN_TTL_MINUTES).max(MAX_TTL_MINUTES).optional(),
});

export const GET = handler(async (ctx: APIContext) => {
  const now = isoNow();
  const flares = await listActiveFlares(env.DB, now);

  // `mine` is the one viewer-specific part of the payload; the flares
  // themselves are identical for everyone and get broadcast verbatim.
  const user = ctx.locals.user;
  const mine = user ? await getViewerRsvps(env.DB, user.id) : {};

  return json({ now, flares, mine }, 200, {
    // A board that is ten seconds stale is a broken board, and the payload is
    // small. Never cache it.
    'cache-control': 'private, no-store',
  });
});

export const POST = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'member');
  const input = await readJson(ctx, flareInput);
  const poiId = input.poiId ?? null;

  // A flare that points at a POI has to point at a real, published one — the
  // board links straight through to /map?poi=<slug>.
  let zoneId: number | null = null;
  if (poiId !== null) {
    const poi = await env.DB.prepare(
      "SELECT id, zone_id FROM pois WHERE id = ?1 AND status = 'published'",
    )
      .bind(poiId)
      .first<{ id: number; zone_id: number }>();
    if (!poi) throw new ApiError(422, 'That location is not on the map');
    zoneId = poi.zone_id;
  }

  if (await hasDuplicateFlare(env.DB, user.id, input.kind, poiId)) {
    throw new ApiError(409, 'You already have that flare open');
  }

  const inserted = await env.DB.prepare(
    `INSERT INTO flares (zone_id, poi_id, kind, boss, tier, needed, note, created_by, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     RETURNING id`,
  )
    .bind(
      zoneId,
      poiId,
      input.kind,
      // Raid details only make sense on a raid; storing them elsewhere would
      // put a boss name on a trade card.
      input.kind === 'raid' ? (input.boss ?? null) : null,
      input.kind === 'raid' ? (input.tier ?? null) : null,
      input.kind === 'remote_invites' ? (input.needed ?? null) : null,
      input.note ?? null,
      user.id,
      expiryFor(input.kind, input.minutes),
    )
    .first<{ id: number }>();

  if (!inserted) throw new ApiError(500, 'Insert did not return an id');

  const flare = await getFlare(env.DB, inserted.id);
  if (!flare) throw new ApiError(500, 'Flare vanished after insert');

  // D1 has the flare; the broadcast is a courtesy to whoever is already
  // watching. Off the response path so a slow or absent Durable Object never
  // delays the trainer who is standing at the gym.
  const background = ctx.locals.cfContext;
  const fanOut = notifyLiveBoard({ type: 'flare', flare });
  if (background) background.waitUntil(fanOut);
  else await fanOut;

  return json({ flare }, 201);
});
