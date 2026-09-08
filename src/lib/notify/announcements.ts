/**
 * Announcing posts and meetups into the community Discord.
 *
 * `announceToDiscord` was written, tested and then never called by anything, so
 * for the whole life of the site publishing a post told nobody. This is the
 * caller.
 *
 * The shape is deliberately the same as `flare-closures.ts`, because the
 * problem is the same one: something has to happen at a moment when nobody is
 * necessarily making a request, and this Worker has no cron trigger (see
 * vault/Why there is no cron.md). Two things want announcing, and both are
 * handled:
 *
 *   published now   the author hit Save on a post that is live, or on a
 *                   meetup. We are already in a request, so it settles there.
 *   scheduled       the post goes public at 6 PM on Friday. Nobody is there to
 *                   tell us, so it is picked up by a sweep on the next read of
 *                   a page that lists posts or meetups.
 *
 * Riding the read is the same trade the flare sweep makes, with one honest
 * difference worth stating: the flares endpoint is polled by every open board,
 * so a lapsed embed settles within seconds. The blog and home pages are much
 * colder. A post scheduled for 6 PM is announced at 6 PM only if somebody loads
 * the site at 6 PM; otherwise it waits for the first visitor after that. It is
 * still announced, and it is still announced exactly once, which are the two
 * properties that matter — but it is not a scheduler and should not be sold as
 * one.
 *
 * `Env` arrives as a parameter and this file imports nothing from
 * `cloudflare:workers`, deliberately. A module-scope `cloudflare:workers`
 * import is what makes `scrapedduck.ts` impossible to unit test, and the embed
 * copy here — what an announcement actually says to the community — is exactly
 * the kind of thing that should be assertable without a Worker.
 * `flare-closures.ts` takes `env` the same way, for the same reason.
 */

import type { APIContext } from 'astro';
import {
  claimMeetupAnnouncements,
  claimPostAnnouncements,
  releaseAnnouncement,
  type PendingMeetupAnnouncement,
  type PendingPostAnnouncement,
} from '~/lib/db/announcements';
import { markdownToText } from '~/lib/markdown';
import { announceToDiscord, webhookUrl, type Announcement } from '~/lib/notify/discord';
import { formatInZone } from '~/lib/time';

/**
 * How many announcements one pass will send.
 *
 * Small on purpose, and smaller than the flare sweep's ten: an announcement is
 * a *new* message in the channel rather than an edit to one already there, so a
 * runaway pass is not a tidy-up going wrong, it is the channel being spammed.
 * The work is idempotent and the next read picks up the remainder.
 */
const SWEEP_LIMIT = 3;

export interface AnnounceResult {
  claimed: number;
  posted: number;
  gone: number;
  released: number;
}

const EMPTY: AnnounceResult = { claimed: 0, posted: 0, gone: 0, released: 0 };

/** Discord will not fetch a relative image URL, and silently drops the embed. */
function absoluteMedia(key: string | null, origin: string): string | undefined {
  return key ? new URL(`/media/${key}`, origin).toString() : undefined;
}

/**
 * How much of a description Discord shows before it stops being an announcement
 * and starts being the post. 300 characters is roughly the excerpt the site
 * itself renders on a card.
 */
const DESCRIPTION_LIMIT = 300;

export function postAnnouncement(row: PendingPostAnnouncement, origin: string): Announcement {
  return {
    title: row.title,
    // The same fallback the blog cards use: the author's excerpt when they
    // wrote one, otherwise the opening of the body. An announcement with no
    // description at all is a bare link, which is worse than either.
    description:
      row.excerpt?.trim() || markdownToText(row.body_md ?? '', DESCRIPTION_LIMIT) || undefined,
    url: new URL(`/blog/${row.slug}`, origin).toString(),
    imageUrl: absoluteMedia(row.hero_key, origin),
  };
}

export function meetupAnnouncement(row: PendingMeetupAnnouncement, origin: string): Announcement {
  const when = formatInZone(row.starts_at, row.tz);
  const where = row.poi_name ?? row.location_text ?? null;

  // Lead with when and where. A meetup announcement that buries the time under
  // the organiser's prose is the one thing a reader needs and cannot find.
  const head = where ? `${when} · ${where}` : when;
  const body = markdownToText(row.description_md ?? '', DESCRIPTION_LIMIT).trim();

  return {
    title: row.title,
    description: body ? `${head}\n\n${body}` : head,
    // The site's own page, not the Campfire link: the anchor is the meetup id,
    // so it survives a rename, and /events is where the rest of the context is.
    url: new URL(`/events#meetup-${row.id}`, origin).toString(),
    imageUrl: absoluteMedia(row.hero_key, origin),
  };
}

/**
 * Send one table's claimed rows, handing back anything worth retrying.
 *
 * Sequential rather than parallel, for the reason the flare sweep is: these all
 * hit the same webhook and Discord rate-limits per channel.
 */
async function send(
  env: Env,
  db: D1Database,
  table: 'posts' | 'meetups',
  announcements: { id: number; announcement: Announcement }[],
): Promise<AnnounceResult> {
  const result: AnnounceResult = { ...EMPTY, claimed: announcements.length };

  for (const { id, announcement } of announcements) {
    const outcome = await announceToDiscord(env, announcement);

    if (outcome === 'posted') {
      result.posted++;
    } else if (outcome === 'gone') {
      // The webhook is unrecoverable. Leave the row claimed so we stop asking;
      // re-announcing later would be a message about a week-old post.
      result.gone++;
    } else {
      // 'retry' or 'disabled'. `disabled` matters most here: if the webhook is
      // unset the message was never sent, and marking the row settled would
      // lose the announcement permanently the moment it is configured.
      await releaseAnnouncement(db, table, id);
      result.released++;
    }
  }

  return result;
}

function merge(a: AnnounceResult, b: AnnounceResult): AnnounceResult {
  return {
    claimed: a.claimed + b.claimed,
    posted: a.posted + b.posted,
    gone: a.gone + b.gone,
    released: a.released + b.released,
  };
}

/**
 * Announce one specific row immediately, straight after the save that asked
 * for it.
 *
 * Goes through the same claim as the sweep, so a save racing a sweep cannot
 * post the same announcement twice. A post saved as a future `scheduled` claims
 * nothing here — it is not public yet — and is picked up later.
 */
export async function announceNow(
  env: Env,
  db: D1Database,
  table: 'posts' | 'meetups',
  id: number,
  now: string,
  origin: string,
): Promise<AnnounceResult> {
  // With no webhook there is nothing to send, and claiming a row only to
  // release it again would put two pointless writes on every save.
  if (!webhookUrl(env)) return { ...EMPTY };

  if (table === 'posts') {
    const rows = await claimPostAnnouncements(db, now, 1, id);
    return send(
      env,
      db,
      'posts',
      rows.map((r) => ({ id: r.id, announcement: postAnnouncement(r, origin) })),
    );
  }

  const rows = await claimMeetupAnnouncements(db, now, 1, id);
  return send(
    env,
    db,
    'meetups',
    rows.map((r) => ({ id: r.id, announcement: meetupAnnouncement(r, origin) })),
  );
}

/**
 * Announce anything that has become public since the last pass, plus retries of
 * whatever a previous pass handed back.
 *
 * Called from the pages that already read posts and meetups. It must never be
 * allowed to fail one of those renders: the site being up matters more than an
 * announcement being prompt, and the next read will try again.
 */
export async function sweepAnnouncements(
  env: Env,
  db: D1Database,
  now: string,
  origin: string,
): Promise<AnnounceResult> {
  if (!webhookUrl(env)) return { ...EMPTY };

  const [posts, meetups] = await Promise.all([
    claimPostAnnouncements(db, now, SWEEP_LIMIT),
    claimMeetupAnnouncements(db, now, SWEEP_LIMIT),
  ]);

  const postResult = await send(
    env,
    db,
    'posts',
    posts.map((r) => ({ id: r.id, announcement: postAnnouncement(r, origin) })),
  );
  const meetupResult = await send(
    env,
    db,
    'meetups',
    meetups.map((r) => ({ id: r.id, announcement: meetupAnnouncement(r, origin) })),
  );

  return merge(postResult, meetupResult);
}

/**
 * What the author is told after a save.
 *
 * Deliberately the *intent*, not the delivery result. Nothing on this site
 * makes a user wait on a Discord round trip — the flare route hands its fan-out
 * to `waitUntil` and reports nothing — and an admin Save is no different. So
 * these three say what will happen, and none of them claims a message has
 * landed in the channel.
 *
 *   off       nobody asked for an announcement.
 *   queued    it will go out: now if the row is already public, on a later
 *             read if it is scheduled ahead, and on a retry if Discord is
 *             having a bad minute.
 *   disabled  DISCORD_WEBHOOK_URL is unset or was rejected, so nothing will be
 *             sent. The request is *kept* — the row still owes an announcement
 *             and will send one the moment a webhook is configured — but the
 *             author needs telling now, rather than wondering for a week why
 *             the channel stayed quiet.
 */
export type AnnounceStatus = 'off' | 'queued' | 'disabled';

/**
 * Kick off the announcement for a row that has just been saved, off the
 * response path.
 *
 * Claiming happens inside `announceNow`, through the same statement the sweep
 * uses, so this racing a concurrent page load cannot produce two embeds.
 */
export async function settleAnnouncement(
  ctx: APIContext,
  env: Env,
  table: 'posts' | 'meetups',
  id: number,
  requested: boolean,
): Promise<AnnounceStatus> {
  if (!requested) return 'off';
  if (!webhookUrl(env)) return 'disabled';

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const work = announceNow(env, env.DB, table, id, now, ctx.url.origin).catch(() => undefined);

  // Same shape as the flare fan-out: hand it to waitUntil where there is a
  // Worker context, and await it otherwise rather than leaving it floating — a
  // detached promise is not guaranteed to finish once the response is sent.
  const background = ctx.locals.cfContext;
  if (background) background.waitUntil(work);
  else await work;

  return 'queued';
}
