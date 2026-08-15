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
import { postFlareToDiscord, type FlareNotification } from '~/lib/notify/discord';
import { sweepFlareDiscordClosures } from '~/lib/notify/flare-closures';
import { sendPush } from '~/lib/notify/push';
import { FLARE_KIND_LABEL } from '~/lib/db/flares';

export const prerender = false;

/** Notification copy. Kept next to the send so the two never drift apart. */
function pushTitle(flare: FlareNotification): string {
  if (flare.kind === 'raid') return flare.boss ? `🔥 ${flare.boss} raid` : '🔥 Raid starting';
  if (flare.kind === 'remote_invites') {
    return flare.needed ? `📣 ${flare.needed} remote invites` : '📣 Remote invites';
  }
  return `${FLARE_KIND_LABEL[flare.kind]} at the park`;
}

function pushBody(flare: FlareNotification): string {
  const where = flare.poi?.name ?? 'Spring Lake Park';
  const who = flare.author ? ` — ${flare.author.name}` : '';
  return flare.note ? `${where}: ${flare.note}` : `${where}${who}`;
}

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

  // A flare that lapses drops off this list on its own, but its Discord embed
  // does not — an embed is already delivered and only an edit can retire it.
  // There is no cron trigger on this Worker, so the board read is what drives
  // it. Off the response path, bounded, and idempotent: see flare-closures.ts.
  const background = ctx.locals.cfContext;
  const sweep = sweepFlareDiscordClosures(env, env.DB, now).catch(() => undefined);
  // Same shape as the fan-out in POST: hand it to waitUntil where there is a
  // Worker context, and await it otherwise rather than leaving it floating —
  // a detached promise is not guaranteed to finish once the response is sent.
  if (background) background.waitUntil(sweep);
  else await sweep;

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
      // A boss name belongs on a raid and on an invite call ("spare invites for
      // Mewtwo") but nowhere else — it would be noise on a trade card. The /go
      // screen asks for it on both, so dropping it for invites would silently
      // discard something the user typed.
      input.kind === 'raid' || input.kind === 'remote_invites' ? (input.boss ?? null) : null,
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

  // D1 has the flare; everything below is delivery. All of it runs off the
  // response path so a slow Discord, a wedged push service or an absent Durable
  // Object never delays the trainer standing at the gym waiting for the button
  // to respond.
  const origin = new URL(ctx.request.url).origin;
  const fanOut = Promise.allSettled([
    notifyLiveBoard({ type: 'flare', flare }),
    postFlareToDiscord(env, flare as unknown as FlareNotification, origin).then((messageId) =>
      messageId
        ? env.DB.prepare('UPDATE flares SET discord_message_id = ?2 WHERE id = ?1')
            .bind(flare.id, messageId)
            .run()
        : undefined,
    ),
    sendPush(
      env,
      'raid',
      {
        title: pushTitle(flare),
        body: pushBody(flare),
        url: `${origin}/live`,
        // One notification per flare, replaced rather than stacked.
        tag: `flare-${flare.id}`,
      },
      user.id,
    ),
  ]);

  const background = ctx.locals.cfContext;
  if (background) background.waitUntil(fanOut);
  else await fanOut;

  return json({ flare }, 201);
});
