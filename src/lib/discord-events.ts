/**
 * Community meetups announced as Discord scheduled events.
 *
 * The meetups table is filled in by hand through the admin screens, which means
 * "Next meetup" sits empty whenever an event was announced in Discord and nobody
 * re-typed it here. This reads the guild's scheduled events so the card fills
 * itself.
 *
 * Shaped deliberately like `getFeed` in scrapedduck.ts: lazy refresh on read,
 * KV cache, and a stale copy kept as the fallback so an upstream wobble degrades
 * to slightly old rather than to empty. That is not imitation for its own sake —
 * wrangler.jsonc documents at length why this Worker has NO cron (a trigger was
 * once declared before a `scheduled()` handler existed and would have errored
 * every thirty minutes forever), so refresh-on-read is the established way to
 * keep something current here.
 *
 * Two places it deliberately differs from that model:
 *
 *   1. An EMPTY list is a valid answer. ScrapedDuck rejects an empty payload
 *      because there is always at least one raid boss, so empty means a
 *      half-written upstream commit. Here a guild genuinely can have no upcoming
 *      events, and treating that as an error would pin a finished meetup on the
 *      page indefinitely — the exact failure this is meant to remove.
 *   2. A missing bot token is reported, not thrown. The credential is added out
 *      of band (`wrangler secret put DISCORD_BOT_TOKEN`), so this module has to
 *      be deployable before it exists and simply do nothing until it does.
 *
 * Nothing here writes to D1. A Discord-sourced meetup therefore shows on the
 * card but does not take RSVPs and is absent from the ICS feed, both of which
 * read the meetups table. That is a known trade, recorded rather than hidden.
 */
import { env } from 'cloudflare:workers';
import { mapEvents, type DiscordMeetup, type RawScheduledEvent } from './discord-events-map';

// Re-exported so callers have one import for this feature; the split exists
// only because the pure half has to be testable outside a Worker.
export { nextDiscordMeetup, type DiscordMeetup } from './discord-events-map';

const API_BASE = 'https://discord.com/api/v10';

const KV_KEY = 'discord-events:v1:scheduled';

/**
 * How long a cached copy counts as current.
 *
 * Shorter than ScrapedDuck's 30 minutes: a raid rotation is announced days
 * ahead, but a meetup can be posted an hour before people need to leave for it,
 * and "automatically" is the whole point of the request.
 */
const FRESH_MS = 10 * 60 * 1000;

/** Janitor only, so an abandoned key stops costing storage. Must exceed FRESH_MS
 *  by a wide margin or the stale fallback would have nothing to fall back to. */
const HARD_TTL_S = 7 * 24 * 60 * 60;

/** A hung fetch must not hold a page render open. */
const FETCH_TIMEOUT_MS = 8000;

export interface DiscordEventsResult {
  events: DiscordMeetup[];
  /** ISO instant this payload came from Discord; null if we have never had one. */
  fetchedAt: string | null;
  /** Past the freshness window, or no copy at all. */
  stale: boolean;
  /** Why the last attempt failed. Surfaced, never thrown. */
  error: string | null;
}

export interface DiscordEventsOptions {
  kv?: KVNamespace;
  /** `Astro.locals.cfContext.waitUntil`, to keep the KV write off the response path. */
  waitUntil?: (promise: Promise<unknown>) => void;
  force?: boolean;
}

interface StoredEvents {
  fetchedAt: string;
  events: DiscordMeetup[];
}

async function fetchUpstream(): Promise<DiscordMeetup[]> {
  // Same widening `discordConfig` uses in lib/auth/discord.ts. Necessary here
  // for a second reason: worker-configuration.d.ts is generated from the
  // deployed Worker, so DISCORD_BOT_TOKEN is genuinely absent from `Env` until
  // the secret is actually set. Typing against it directly would not compile.
  const e = env as unknown as Record<string, string | undefined>;
  const token = e.DISCORD_BOT_TOKEN;
  const guildId = e.DISCORD_GUILD_ID;

  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set on this Worker');
  if (!guildId) throw new Error('DISCORD_GUILD_ID is not set');

  const res = await fetch(`${API_BASE}/guilds/${guildId}/scheduled-events`, {
    headers: { authorization: `Bot ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (res.status === 401 || res.status === 403) {
    // Worth separating from a generic failure: this is the shape a rotated or
    // wrongly-scoped token takes, and it will not fix itself with a retry.
    throw new Error(`Discord rejected the bot token (${res.status}) — is the bot in the guild?`);
  }
  if (!res.ok) throw new Error(`scheduled-events responded ${res.status}`);

  const parsed: unknown = await res.json();
  if (!Array.isArray(parsed)) throw new Error('scheduled-events was not a JSON array');

  return mapEvents(parsed as RawScheduledEvent[], guildId);
}

async function readCache(kv: KVNamespace): Promise<StoredEvents | null> {
  try {
    const stored = await kv.get<StoredEvents>(KV_KEY, 'json');
    if (!stored || !Array.isArray(stored.events) || typeof stored.fetchedAt !== 'string') return null;
    return stored;
  } catch (err) {
    console.error('Discord events cache read failed', err);
    return null;
  }
}

async function writeCache(kv: KVNamespace, stored: StoredEvents): Promise<void> {
  try {
    await kv.put(KV_KEY, JSON.stringify(stored), { expirationTtl: HARD_TTL_S });
  } catch (err) {
    // Good data is already in hand; failing to memoise it must not downgrade
    // this response to an error.
    console.error('Discord events cache write failed', err);
  }
}

function ageOf(stored: StoredEvents): number {
  const age = Date.now() - Date.parse(stored.fetchedAt);
  return Number.isFinite(age) ? age : Number.POSITIVE_INFINITY;
}

/**
 * Upcoming guild events, preferring cache and falling back to the last good copy.
 *
 * Never throws. An outage is reported through `stale` / `error` so the caller
 * can decide what to show, exactly as the raid feed does.
 */
export async function getDiscordEvents(
  options: DiscordEventsOptions = {},
): Promise<DiscordEventsResult> {
  const kv = options.kv ?? env.CACHE;
  const cached = kv ? await readCache(kv) : null;

  if (!options.force && cached && ageOf(cached) < FRESH_MS) {
    return { events: cached.events, fetchedAt: cached.fetchedAt, stale: false, error: null };
  }

  try {
    const events = await fetchUpstream();
    const stored: StoredEvents = { fetchedAt: new Date().toISOString(), events };
    if (kv) {
      const write = writeCache(kv, stored);
      if (options.waitUntil) options.waitUntil(write);
      else await write;
    }
    return { events, fetchedAt: stored.fetchedAt, stale: false, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached) {
      // Old but real beats empty: a meetup announced yesterday is still the
      // right answer while Discord is briefly unreachable.
      return { events: cached.events, fetchedAt: cached.fetchedAt, stale: true, error: message };
    }
    return { events: [], fetchedAt: null, stale: true, error: message };
  }
}
