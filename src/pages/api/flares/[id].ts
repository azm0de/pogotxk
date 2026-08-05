/**
 * Acting on a flare.
 *
 *   PATCH /api/flares/:id   { action: 'rsvp', state: 'coming' | 'here' | 'done' | 'out' }
 *   PATCH /api/flares/:id   { action: 'close' }
 *
 * Both write to D1 first and then tell the Durable Object, so the board a
 * client sees is always a projection of what is actually stored.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ApiError, handler, intParam, json, requireRole, requireUser } from '~/lib/api';
import { hasRole } from '~/lib/auth/types';
import { recordAudit } from '~/lib/db/audit';
import { getFlare, getFlareOwnership, isoNow } from '~/lib/db/flares';
import { notifyLiveBoard } from '~/do/LiveBoard';

export const prerender = false;

const patchInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('rsvp'),
    // 'out' is not a stored state — the schema only allows coming/here/done —
    // it is how a client says "take my name off", which deletes the row.
    state: z.enum(['coming', 'here', 'done', 'out']),
  }),
  z.object({ action: z.literal('close') }),
]);

/**
 * `readJson` is not used here: a discriminated union produces issue paths that
 * only make sense with the discriminant echoed back, and the board's error
 * surface is a toast rather than a form.
 */
async function readAction(ctx: APIContext): Promise<z.infer<typeof patchInput>> {
  let raw: unknown;
  try {
    raw = await ctx.request.json();
  } catch {
    throw new ApiError(400, 'Body must be valid JSON');
  }
  const parsed = patchInput.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, 'Expected an rsvp or close action');
  return parsed.data;
}

export const PATCH = handler(async (ctx: APIContext) => {
  const id = intParam(ctx, 'id');
  const input = await readAction(ctx);

  const flare = await getFlareOwnership(env.DB, id);
  if (!flare) throw new ApiError(404, 'Flare not found');

  if (input.action === 'rsvp') {
    const user = requireRole(ctx, 'member');

    // 410 rather than 404: the flare existed, the moment passed. The client
    // uses the distinction to drop the card instead of showing an error.
    if (flare.closed_at !== null || flare.expires_at <= isoNow()) {
      throw new ApiError(410, 'That flare is over');
    }

    if (input.state === 'out') {
      await env.DB.prepare('DELETE FROM flare_rsvps WHERE flare_id = ?1 AND user_id = ?2')
        .bind(id, user.id)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO flare_rsvps (flare_id, user_id, state) VALUES (?1, ?2, ?3)
         ON CONFLICT (flare_id, user_id)
         DO UPDATE SET state = excluded.state,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
      )
        .bind(id, user.id, input.state)
        .run();
    }

    const updated = await getFlare(env.DB, id);
    if (!updated) throw new ApiError(404, 'Flare not found');

    await fanOut(ctx, { type: 'update', flare: updated });
    return json({ flare: updated, mine: input.state === 'out' ? null : input.state });
  }

  // --- close --------------------------------------------------------------
  const user = requireUser(ctx);

  // Whoever raised it can stand it down; ambassadors can too, because a flare
  // posted in error outlives the poster's attention span.
  const isOwner = flare.created_by === user.id;
  if (!isOwner && !hasRole(user, 'ambassador')) {
    throw new ApiError(403, 'Only the trainer who raised this can close it');
  }

  if (flare.closed_at === null) {
    await env.DB.prepare(
      "UPDATE flares SET closed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?1 AND closed_at IS NULL",
    )
      .bind(id)
      .run();

    // Only moderation is worth an audit row. Closing your own flare is routine;
    // closing someone else's is an action a member may want explained.
    if (!isOwner) {
      await recordAudit(env.DB, {
        actorId: user.id,
        action: 'update',
        entity: 'flare',
        entityId: id,
        diff: { closed_at: { from: null, to: 'now' }, byModerator: true },
      });
    }
  }

  await fanOut(ctx, { type: 'closed', id });
  return json({ id, closed: true });
});

/** Broadcast off the response path — see the note in ./index.ts. */
async function fanOut(
  ctx: APIContext,
  event: Parameters<typeof notifyLiveBoard>[0],
): Promise<void> {
  const background = ctx.locals.cfContext;
  const promise = notifyLiveBoard(event);
  if (background) background.waitUntil(promise);
  else await promise;
}
