/**
 * Closing a flare's Discord embed once the flare is over.
 *
 * The live board never needs a sweep: `listActiveFlares` compares `expires_at`
 * on every read, so a lapsed flare simply stops being returned. Discord is the
 * opposite kind of surface — the embed is already sitting in the channel, and
 * the only way it stops saying "🔥 Raid starting" is if something goes back and
 * edits it. Nothing did, which is why every flare ever posted to Discord stayed
 * looking live.
 *
 * Two things end a flare, and both have to be handled:
 *
 *   closed   somebody stood it down. We know the instant it happens, so the
 *            close request settles its own embed directly.
 *   expired  it just lapsed. Nobody is there to tell us, and there is no cron
 *            trigger on this Worker, so it gets picked up by a sweep on the
 *            next board read.
 *
 * Riding the board read is a deliberate trade rather than a workaround. The
 * flares endpoint is polled by every open board and hit again on every socket
 * reconnect, so in practice a lapsed embed settles within seconds of anyone
 * looking at the site. If nobody is looking, the embed stays live a while
 * longer — but nobody is being misled in that window either, and the first
 * visitor afterwards clears the backlog. The alternative is a cron trigger,
 * which this Worker has none of and which would mean adding a `scheduled`
 * export to an adapter-generated entry module that only exports `default` (see
 * the Durable Object surgery in astro.config.mjs for how that goes).
 */

import {
  claimFlaresForDiscordClose,
  releaseFlareDiscordClose,
  type PendingDiscordClose,
} from '~/lib/db/flares';
import { markFlareClosedInDiscord, webhookUrl } from '~/lib/notify/discord';

/**
 * How many embeds one pass will edit.
 *
 * Discord rate-limits webhooks per channel, and a busy evening can lapse a
 * dozen flares within the same minute. A bounded pass keeps any single request
 * cheap and lets the next read pick up the remainder — the work is idempotent,
 * so spreading it out costs nothing.
 */
const SWEEP_LIMIT = 10;

/** Result counts, for logging and for the tests. */
export interface SweepResult {
  claimed: number;
  edited: number;
  gone: number;
  released: number;
}

async function settle(
  env: Env,
  db: D1Database,
  rows: PendingDiscordClose[],
): Promise<SweepResult> {
  const result: SweepResult = { claimed: rows.length, edited: 0, gone: 0, released: 0 };

  // Sequential rather than parallel: these all hit the same webhook, and the
  // per-channel rate limit is the binding constraint. Ten at once is how you
  // turn a tidy sweep into a 429 storm that releases everything and retries it
  // all again on the next read.
  for (const row of rows) {
    const outcome = await markFlareClosedInDiscord(
      env,
      row.discord_message_id,
      row.closed_at ? 'closed' : 'expired',
    );

    if (outcome === 'edited') {
      result.edited++;
    } else if (outcome === 'gone') {
      // The message or webhook is unrecoverable. Leave it claimed so we stop
      // asking.
      result.gone++;
    } else {
      // 'retry' or 'disabled' — hand it back for a later pass. `disabled`
      // matters here: if the webhook is unset, the embed was never posted by
      // this deployment and marking it settled would lose the edit forever if
      // the webhook is configured a minute later.
      await releaseFlareDiscordClose(db, row.id);
      result.released++;
    }
  }

  return result;
}

/**
 * Settle the embed for one specific flare, immediately after it is closed.
 *
 * Goes through the same claim as the sweep, so a close racing the sweep cannot
 * produce two edits of the same message.
 */
export async function closeFlareInDiscord(
  env: Env,
  db: D1Database,
  id: number,
  now: string,
): Promise<SweepResult> {
  // Same early exit as the sweep: with no webhook there is no embed to retire,
  // and claiming the row only to release it again would put two writes on every
  // close for no reason.
  if (!webhookUrl(env)) return { claimed: 0, edited: 0, gone: 0, released: 0 };

  const rows = await claimFlaresForDiscordClose(db, now, 1, id);
  return settle(env, db, rows);
}

/**
 * Settle any embeds whose flares have ended — expiries, plus retries of
 * anything a previous pass handed back.
 */
export async function sweepFlareDiscordClosures(
  env: Env,
  db: D1Database,
  now: string,
): Promise<SweepResult> {
  // With no webhook configured there are no embeds to retire, and claiming
  // rows only to hand them straight back would put two pointless writes on
  // every board read — the hottest endpoint on the site. This is the normal
  // state for any deployment that has not set DISCORD_WEBHOOK_URL, so it is
  // worth the early exit rather than relying on the sweep finding nothing.
  if (!webhookUrl(env)) return { claimed: 0, edited: 0, gone: 0, released: 0 };

  const rows = await claimFlaresForDiscordClose(db, now, SWEEP_LIMIT);
  return settle(env, db, rows);
}
