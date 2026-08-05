/**
 * ScrapedDuck — live Pokémon GO game data (raid bosses, egg pools, field
 * research, events), mirrored from Leek Duck as plain JSON on GitHub.
 *
 * Two constraints shape this module.
 *
 * 1. LICENCE. ScrapedDuck scrapes leekduck.com and permits reuse only with
 *    visible attribution to *both* projects, and only on pages that are not
 *    paywalled and carry no ads. Every page that renders this data must include
 *    `~/components/game/Attribution.astro`. The constants below exist so the
 *    links are never retyped (and never quietly dropped).
 *
 * 2. AVAILABILITY. GitHub raw is fast and free but it is somebody else's
 *    server, and a raid list that is two hours old is enormously more useful to
 *    a trainer standing at a gym than an error page. So the cache is
 *    deliberately *not* a plain TTL cache: the KV entry never expires on the
 *    30-minute boundary, it just stops being considered fresh. When upstream is
 *    down we keep serving the last good copy and tell the reader how old it is.
 *
 * The types here were derived by reading the actual payloads, not the README —
 * every field below was observed in live data.
 */

import { env } from 'cloudflare:workers';

/** Attribution targets. Both are required on any page that renders this data. */
export const SCRAPEDDUCK_URL = 'https://github.com/bigfoott/ScrapedDuck';
export const LEEKDUCK_URL = 'https://leekduck.com';

const UPSTREAM_BASE = 'https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data';

export const FEEDS = ['raids', 'eggs', 'research', 'events'] as const;
export type FeedName = (typeof FEEDS)[number];

export function isFeedName(value: string): value is FeedName {
  return (FEEDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ types -- */

/** A type, weather, or bonus chip: a display name plus a leekduck.com icon. */
export interface NamedImage {
  name: string;
  image: string;
}

export interface CpRange {
  min: number;
  max: number;
}

export interface RaidBoss {
  name: string;
  /** Display string, e.g. "1-Star Raids", "5-Star Raids", "Mega Raids". */
  tier: string;
  canBeShiny: boolean;
  types: NamedImage[];
  combatPower: { normal: CpRange; boosted: CpRange };
  /** Weather that boosts this boss — also raises the catch CP to `boosted`. */
  boostedWeather: NamedImage[];
  image: string;
}

export interface EggEntry {
  name: string;
  /** Display string, e.g. "2 km", "10 km", "12 km". */
  eggType: string;
  isAdventureSync: boolean;
  image: string;
  canBeShiny: boolean;
  /** Hatches are fixed at level 20, so this is the whole possible CP spread. */
  combatPower: CpRange;
  isRegional: boolean;
  isGiftExchange: boolean;
  /** Leek Duck's own rarity tier for this species within its pool, 1–5. */
  rarity: number;
}

export interface ResearchReward {
  name: string;
  image: string;
  canBeShiny: boolean;
  combatPower: CpRange;
}

export interface ResearchTask {
  /** Arrives wrapped in markup, e.g. "<span>Catch 7 Pokémon</span>". */
  text: string;
  /** Task category: catch | throw | battle | explore | training | buddy | rocket. Absent on a few tasks. */
  type?: string;
  rewards: ResearchReward[];
}

export interface EventSpotlight {
  name: string;
  canBeShiny: boolean;
  image: string;
  bonus: string;
  list: { name: string; canBeShiny: boolean; image: string }[];
}

export interface EventCommunityDay {
  spawns: NamedImage[];
  bonuses: { text: string; image: string }[];
  bonusDisclaimers: string[];
  shinies: NamedImage[];
  specialresearch: {
    name: string;
    step: number;
    tasks: { text: string; reward: { text: string; image: string } }[];
    rewards?: { text: string; image: string }[];
  }[];
}

export interface GameEvent {
  eventID: string;
  name: string;
  eventType: string;
  heading: string;
  link: string;
  image: string;
  /**
   * Usually a *naive* local-time ISO string ("2026-08-16T14:00:00.000") because
   * most in-game events start at 2 PM in whatever zone you are standing in;
   * season-length events carry a real UTC "Z". Consumers must check for the
   * suffix before handing this to `new Date()`.
   */
  start: string;
  end: string;
  extraData: {
    generic?: { hasSpawns: boolean; hasFieldResearchTasks: boolean };
    spotlight?: EventSpotlight;
    raidbattles?: { bosses: NamedImage[]; shinies: NamedImage[] };
    communityday?: EventCommunityDay;
  } | null;
}

/** Maps a feed name to the shape of one entry in it. */
export interface FeedTypes {
  raids: RaidBoss;
  eggs: EggEntry;
  research: ResearchTask;
  events: GameEvent;
}

export type FeedEntry<F extends FeedName> = FeedTypes[F];

/* ------------------------------------------------------------------ cache -- */

const KV_PREFIX = 'scrapedduck:v1:';

/** How long a cached copy counts as current. Matches the 30-minute cron. */
const FRESH_MS = 30 * 60 * 1000;

/**
 * How long KV keeps the entry at all. This is *not* the cache TTL — it is a
 * janitor, so a feed we stop asking for eventually stops costing storage. It
 * has to be far longer than FRESH_MS or the stale-fallback below would have
 * nothing to fall back to during an outage.
 */
const HARD_TTL_S = 7 * 24 * 60 * 60;

/** A hung fetch must not hold a page render open. */
const FETCH_TIMEOUT_MS = 8000;

interface StoredFeed {
  fetchedAt: string;
  data: unknown[];
}

export interface FeedResult<F extends FeedName> {
  feed: F;
  data: FeedEntry<F>[];
  /** ISO instant this payload was pulled from upstream; null if we never got one. */
  fetchedAt: string | null;
  /** True when the copy is past the freshness window, or when there is no copy. */
  stale: boolean;
  /** Why the last upstream attempt failed. Surfaced to the reader, never thrown. */
  error: string | null;
}

export interface FeedOptions {
  /** Defaults to the CACHE binding; a scheduled handler can pass its own. */
  kv?: KVNamespace;
  /** Hand in `Astro.locals.cfContext.waitUntil` to keep the KV write off the response path. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Refetch even if the cached copy is still fresh. Used by the cron. */
  force?: boolean;
}

async function fetchUpstream(feed: FeedName): Promise<unknown[]> {
  const res = await fetch(`${UPSTREAM_BASE}/${feed}.json`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`${feed}.json responded ${res.status}`);

  const parsed: unknown = await res.json();
  if (!Array.isArray(parsed)) throw new Error(`${feed}.json was not a JSON array`);

  // An empty array is never a real answer from these feeds — there is always at
  // least one active raid boss and one egg in the pool. Rejecting it stops a
  // half-written upstream commit from overwriting a good cached copy with
  // nothing, which would look identical to "there are no raids today".
  if (parsed.length === 0) throw new Error(`${feed}.json was empty`);

  return parsed;
}

async function readCache(kv: KVNamespace, feed: FeedName): Promise<StoredFeed | null> {
  try {
    const stored = await kv.get<StoredFeed>(`${KV_PREFIX}${feed}`, 'json');
    if (!stored || !Array.isArray(stored.data) || typeof stored.fetchedAt !== 'string') return null;
    return stored;
  } catch (err) {
    // A cache read failure is not a page failure — fall through to upstream.
    console.error(`ScrapedDuck cache read failed for ${feed}`, err);
    return null;
  }
}

async function writeCache(kv: KVNamespace, feed: FeedName, stored: StoredFeed): Promise<void> {
  try {
    await kv.put(`${KV_PREFIX}${feed}`, JSON.stringify(stored), { expirationTtl: HARD_TTL_S });
  } catch (err) {
    // We already have good data in hand; failing to memoise it must not
    // downgrade this response to an error.
    console.error(`ScrapedDuck cache write failed for ${feed}`, err);
  }
}

function ageOf(stored: StoredFeed): number {
  const age = Date.now() - Date.parse(stored.fetchedAt);
  return Number.isFinite(age) ? age : Number.POSITIVE_INFINITY;
}

/**
 * Read a feed, preferring the cache and falling back to whatever we last saw.
 *
 * Never throws: an outage is reported through `stale`/`error` so the caller can
 * render a banner over real (if old) data instead of an error page.
 */
export async function getFeed<F extends FeedName>(
  feed: F,
  options: FeedOptions = {},
): Promise<FeedResult<F>> {
  const kv = options.kv ?? env.CACHE;
  const cached = await readCache(kv, feed);

  if (cached && !options.force && ageOf(cached) < FRESH_MS) {
    return {
      feed,
      data: cached.data as FeedEntry<F>[],
      fetchedAt: cached.fetchedAt,
      stale: false,
      error: null,
    };
  }

  try {
    const data = await fetchUpstream(feed);
    const stored: StoredFeed = { fetchedAt: new Date().toISOString(), data };

    const write = writeCache(kv, feed, stored);
    if (options.waitUntil) options.waitUntil(write);
    else await write;

    return {
      feed,
      data: data as FeedEntry<F>[],
      fetchedAt: stored.fetchedAt,
      stale: false,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ScrapedDuck ${feed} refresh failed`, message);

    if (cached) {
      return {
        feed,
        data: cached.data as FeedEntry<F>[],
        fetchedAt: cached.fetchedAt,
        stale: true,
        error: message,
      };
    }

    return { feed, data: [], fetchedAt: null, stale: true, error: message };
  }
}

export interface FeedRefresh {
  feed: FeedName;
  ok: boolean;
  count: number;
  error: string | null;
}

export interface RefreshSummary {
  refreshedAt: string;
  results: FeedRefresh[];
}

/**
 * Refresh every feed. Call this from the Worker's `scheduled` handler — the
 * cron already fires every 30 minutes, which is ~192 upstream requests a day
 * against a 5000/hour limit, and GitHub caches raw files for 5 minutes anyway.
 *
 * `target` lets the scheduled handler pass the env it was handed; it falls back
 * to the ambient binding for callers already inside a request.
 */
export async function refreshAllFeeds(
  target?: Pick<Cloudflare.Env, 'CACHE'>,
): Promise<RefreshSummary> {
  const kv = target?.CACHE ?? env.CACHE;

  const results = await Promise.all(
    FEEDS.map(async (feed): Promise<FeedRefresh> => {
      const result = await getFeed(feed, { kv, force: true });
      return { feed, ok: !result.stale, count: result.data.length, error: result.error };
    }),
  );

  return { refreshedAt: new Date().toISOString(), results };
}

/* ----------------------------------------------------------- presentation -- */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Research task text arrives as a fragment of Leek Duck's own markup
 * ("<span>Catch 7 Pokémon</span>"). We want the words, not the span — and we
 * never want to render upstream HTML unescaped, so this strips rather than
 * sanitises.
 */
export function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&[#a-z0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "637" when the spread is a single value, "688–739" otherwise.
 *
 * Tolerates a missing or malformed range. The payload is a third-party scrape:
 * `fetchUpstream` proves it is a non-empty array but nothing checks the shape of
 * the entries inside it, and one boss arriving without `combatPower` would throw
 * out of the template and 500 the whole page. Worse, that payload is written to
 * KV *before* the render runs, so the 500 would outlive the bad upstream commit.
 * A dash on one card is the failure this module promises everywhere else.
 */
export function formatCp(range: CpRange | null | undefined): string {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return '—';
  return range.min === range.max ? String(range.min) : `${range.min}–${range.max}`;
}

/**
 * Non-numeric raid tiers, checked longest-first so "Mega Legendary" is not
 * swallowed by the "mega" test.
 */
const NAMED_TIERS: readonly (readonly [pattern: string, rank: number])[] = [
  ['mega legendary', 110],
  ['mega', 100],
  ['primal', 120],
  ['ultra beast', 130],
  ['elite', 140],
];

/**
 * Sort key for a raid tier.
 *
 * Niantic invents new tiers (Elite, Primal, Shadow, Mega Legendary) faster than
 * anyone updates a constant, so rank is derived from the string: star tiers by
 * their number, named tiers in a fixed order after them, Shadow variants after
 * everything, and an unrecognised tier at the end — visible rather than lost.
 */
export function raidTierRank(tier: string): number {
  const t = tier.toLowerCase();
  const shadowOffset = t.includes('shadow') ? 1000 : 0;

  const stars = /(\d+)[\s-]*star/.exec(t);
  if (stars) return shadowOffset + Number(stars[1]);

  for (const [pattern, rank] of NAMED_TIERS) {
    if (t.includes(pattern)) return shadowOffset + rank;
  }
  return shadowOffset + 900;
}

/** Stable slug for a tier, used as a CSS hook: "5-Star Raids" -> "5-star-raids". */
export function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Egg pools sort by walking distance: 1, 2, 5, 7, 10, 12 km. */
export function eggDistanceRank(eggType: string): number {
  const km = /(\d+)/.exec(eggType);
  return km ? Number(km[1]) : 999;
}

const RESEARCH_ORDER = ['catch', 'throw', 'explore', 'battle', 'rocket', 'training', 'buddy'];

const RESEARCH_LABELS: Record<string, string> = {
  catch: 'Catching',
  throw: 'Throwing',
  explore: 'Exploring',
  battle: 'Battling',
  rocket: 'Team GO Rocket',
  training: 'Training',
  buddy: 'Buddy',
  other: 'Other tasks',
};

export function researchCategoryRank(type: string): number {
  if (type === 'other') return 999;
  const index = RESEARCH_ORDER.indexOf(type);
  return index === -1 ? 500 : index;
}

export function researchCategoryLabel(type: string): string {
  // Unknown categories are title-cased rather than bucketed into "Other", so a
  // new upstream category still reads as itself.
  return RESEARCH_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

export interface Group<T> {
  key: string;
  items: T[];
}

/** Group items by a derived key, with the groups themselves in `rankOf` order. */
export function groupSorted<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  rankOf: (key: string) => number,
): Group<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  return [...groups.entries()]
    .map(([key, groupItems]) => ({ key, items: groupItems }))
    .sort((a, b) => rankOf(a.key) - rankOf(b.key) || a.key.localeCompare(b.key));
}

/** "12 minutes ago" — coarse on purpose; the exact clock time sits beside it. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';

  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 60_000) return 'just now';

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
