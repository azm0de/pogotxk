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
import { closeFlareInDiscord } from '~/lib/notify/flare-closures';
import { updateFlareEmbedInDiscord, type FlareNotification } from '~/lib/notify/discord';

export const prerender = false;

const patchInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('rsvp'),
    // 'out' is not a stored state — the schema only allows coming/here/done —
    // it is how a client says "take my name off", which deletes the row.
    state: z.enum(['coming', 'here', 'done', 'out']),
  }),
  z.object({ action: z.literal('close') }),
  /*
   * Correcting a flare that is already out.
   *
   * Only boss and tier: they are the two things people get wrong in the thirty
   * seconds before a raid starts, and they are the two the embed and the board
   * both display. Deliberately NOT the location or the kind — those decide
   * which POI the flare hangs off and how long it lives, and changing them
   * after the fact is indistinguishable from raising a different flare.
   *
   * `.optional()` and `.nullable()` mean different things here and the
   * distinction is load-bearing: an absent key leaves the field alone, an
   * explicit null clears it.
   */
  z.object({
    action: z.literal('edit'),
    boss: z.string().trim().max(80).nullable().optional(),
    tier: z.string().trim().max(24).nullable().optional(),
  }),
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
  if (!parsed.success) throw new ApiError(422, 'Expected an rsvp, edit or close action');
  return parsed.data;
}

/**
 * Who may change a flare after it is out: whoever raised it, plus ambassadors.
 *
 * The same rule as closing, and stated once so the two cannot drift — an
 * ambassador who can stand a flare down but not fix its boss would just stand it
 * down and ask the trainer to fire a corrected one, which is worse for everybody
 * in the channel.
 */
function assertMayAlter(ctx: APIContext, createdBy: number | null): { userId: number; isOwner: boolean } {
  const user = requireUser(ctx);
  const isOwner = createdBy === user.id;
  if (!isOwner && !hasRole(user, 'ambassador')) {
    throw new ApiError(403, 'Only the trainer who raised this can change it');
  }
  return { userId: user.id, isOwner };
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

  // --- edit ----------------------------------------------------------------
  if (input.action === 'edit') {
    const { userId, isOwner } = assertMayAlter(ctx, flare.created_by);

    // Same 410 as an rsvp: the flare existed, the moment passed. Correcting a
    // flare nobody can act on only rewrites history.
    if (flare.closed_at !== null || flare.expires_at <= isoNow()) {
      throw new ApiError(410, 'That flare is over');
    }

    // Mirrors what POST /api/flares stores per kind. Without this a boss could
    // be attached to a trade flare through the back door, where the create path
    // deliberately drops it — and the board would render a field the UI has no
    // way to have produced.
    const bossAllowed = flare.kind === 'raid' || flare.kind === 'remote_invites';
    if (input.boss !== undefined && !bossAllowed) {
      throw new ApiError(422, 'That kind of flare does not carry a boss');
    }
    if (input.tier !== undefined && flare.kind !== 'raid') {
      throw new ApiError(422, 'Only a raid carries a tier');
    }
    if (input.boss === undefined && input.tier === undefined) {
      throw new ApiError(422, 'Nothing to change');
    }

    // Built by hand rather than with COALESCE so that an explicit null CLEARS
    // the field: COALESCE(?, boss) cannot express "set this to nothing", and
    // removing a boss you typed by mistake is half the point of an edit.
    const sets: string[] = [];
    const binds: (string | null)[] = [];
    if (input.boss !== undefined) {
      binds.push(input.boss || null);
      sets.push(`boss = ?${binds.length + 1}`);
    }
    if (input.tier !== undefined) {
      binds.push(input.tier || null);
      sets.push(`tier = ?${binds.length + 1}`);
    }

    await env.DB.prepare(`UPDATE flares SET ${sets.join(', ')} WHERE id = ?1`)
      .bind(id, ...binds)
      .run();

    const updated = await getFlare(env.DB, id);
    if (!updated) throw new ApiError(404, 'Flare not found');

    // Same rule as closing: routine on your own flare, worth explaining on
    // someone else's.
    if (!isOwner) {
      await recordAudit(env.DB, {
        actorId: userId,
        action: 'update',
        entity: 'flare',
        entityId: id,
        diff: { boss: input.boss, tier: input.tier, byModerator: true },
      });
    }

    /*
     * The embed in Discord still names the old boss, and an embed already
     * delivered is only reachable by editing it — exactly the problem the close
     * path exists to solve. Rides the same waitUntil so a rate-limited Discord
     * never keeps the trainer's Save button spinning.
     */
    const origin = new URL(ctx.request.url).origin;
    await fanOut(
      ctx,
      { type: 'update', flare: updated },
      flare.discord_message_id
        ? updateFlareEmbedInDiscord(
            env,
            flare.discord_message_id,
            updated as unknown as FlareNotification,
            origin,
          )
        : undefined,
    );
    return json({ flare: updated });
  }

  // --- close --------------------------------------------------------------
  // Whoever raised it can stand it down; ambassadors can too, because a flare
  // posted in error outlives the poster's attention span.
  const { userId, isOwner } = assertMayAlter(ctx, flare.created_by);

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
        actorId: userId,
        action: 'update',
        entity: 'flare',
        entityId: id,
        diff: { closed_at: { from: null, to: 'now' }, byModerator: true },
      });
    }
  }

  // The embed in Discord is still advertising this flare. Striking it through
  // runs off the response path for the same reason the fan-out does — a slow or
  // rate-limited Discord must not keep the trainer's "close" button spinning.
  // The row is claimed transactionally, so this is safe to run alongside the
  // sweep on the read path.
  await fanOut(ctx, { type: 'closed', id }, closeFlareInDiscord(env, env.DB, id, isoNow()));
  return json({ id, closed: true });
});

/**
 * Broadcast off the response path — see the note in ./index.ts.
 *
 * `extra` carries any delivery work that should ride along on the same
 * `waitUntil`, such as striking through the Discord embed. It is settled
 * together with the broadcast so one slow leg cannot delay the other, and
 * failures are swallowed: none of this is allowed to fail the request that
 * already succeeded in D1.
 */
async function fanOut(
  ctx: APIContext,
  event: Parameters<typeof notifyLiveBoard>[0],
  extra?: Promise<unknown>,
): Promise<void> {
  const background = ctx.locals.cfContext;
  const work = Promise.allSettled(extra ? [notifyLiveBoard(event), extra] : [notifyLiveBoard(event)]);
  if (background) background.waitUntil(work);
  else await work;
}
