/**
 * Read model for the live board.
 *
 * A flare is a short-lived broadcast — "raid at Bramlett Field, come join".
 * Expiry is evaluated against a timestamp on every read rather than stored as a
 * flag, so a flare falls off the board the moment `expires_at` passes and no
 * cron has to sweep the table. The rows stay behind as history.
 *
 * Nothing here is viewer-specific: the same `Flare` object is fanned out over
 * the WebSocket to every connected client, so "did *I* RSVP" has to be a
 * separate lookup (`getViewerRsvps`) rather than a field on the row.
 */

import type { Team } from '~/lib/auth/types';
import type { PoiType } from '~/lib/db/map';

export const FLARE_KINDS = [
  'raid',
  'gym_takedown',
  'meetup_here',
  'remote_invites',
  'trade',
  'help',
] as const;

export type FlareKind = (typeof FLARE_KINDS)[number];

export const FLARE_KIND_LABEL: Record<FlareKind, string> = {
  raid: 'Raid',
  gym_takedown: 'Gym takedown',
  meetup_here: 'Meet me here',
  remote_invites: 'Remote invites',
  trade: 'Trade',
  help: 'Need a hand',
};

/**
 * Default lifetime per kind, in minutes.
 *
 * These track how long the underlying thing is actually useful for, not a round
 * number: a raid egg plus the battle window is under 45 minutes, an invite call
 * goes stale as soon as the lobby fills, and a trade offer can sit for an
 * afternoon. Getting these right is what keeps the board honest without anyone
 * having to remember to close their own flare.
 */
export const FLARE_TTL_MINUTES: Record<FlareKind, number> = {
  raid: 45,
  gym_takedown: 30,
  meetup_here: 120,
  remote_invites: 20,
  trade: 120,
  help: 60,
};

/** Bounds for a caller-supplied lifetime override. */
export const MIN_TTL_MINUTES = 5;
export const MAX_TTL_MINUTES = 240;

export type FlareRsvpState = 'coming' | 'here' | 'done';

export interface FlareAuthor {
  id: number;
  /** Trainer name where we have one — that is the handle people recognise. */
  name: string;
  team: Team | null;
}

export interface FlarePoi {
  id: number;
  slug: string;
  name: string;
  type: PoiType;
  lat: number;
  lng: number;
}

export interface Flare {
  id: number;
  kind: FlareKind;
  boss: string | null;
  tier: string | null;
  needed: number | null;
  note: string | null;
  poi: FlarePoi | null;
  author: FlareAuthor | null;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
  rsvps: Record<FlareRsvpState, number>;
}

/**
 * ISO-8601 UTC to the second — the format every timestamp in D1 uses (see the
 * header of migrations/0001_initial.sql). Keeping the shape identical matters
 * because `expires_at` is compared against `created_at` defaults as text.
 */
export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The expiry a new flare of `kind` should carry. */
export function expiryFor(kind: FlareKind, minutes?: number): string {
  const ttl = Math.min(
    MAX_TTL_MINUTES,
    Math.max(MIN_TTL_MINUTES, minutes ?? FLARE_TTL_MINUTES[kind]),
  );
  return new Date(Date.now() + ttl * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface FlareRow {
  id: number;
  kind: FlareKind;
  boss: string | null;
  tier: string | null;
  needed: number | null;
  note: string | null;
  created_at: string;
  expires_at: string;
  closed_at: string | null;
  poi_id: number | null;
  poi_slug: string | null;
  poi_name: string | null;
  poi_type: PoiType | null;
  poi_lat: number | null;
  poi_lng: number | null;
  author_id: number | null;
  author_trainer_name: string | null;
  author_global_name: string | null;
  author_username: string | null;
  author_team: Team | null;
  rsvp_coming: number;
  rsvp_here: number;
  rsvp_done: number;
}

/**
 * The RSVP counts are aggregated in the same statement rather than fetched per
 * flare — the board renders 20-odd rows and a second round trip per row would
 * dominate the response time. Grouping by the primary key makes the bare
 * columns unambiguous.
 */
const SELECT_FLARE = `
  SELECT f.id, f.kind, f.boss, f.tier, f.needed, f.note,
         f.created_at, f.expires_at, f.closed_at,
         p.id AS poi_id, p.slug AS poi_slug, p.name AS poi_name, p.type AS poi_type,
         p.lat AS poi_lat, p.lng AS poi_lng,
         u.id AS author_id, u.trainer_name AS author_trainer_name,
         u.global_name AS author_global_name, u.username AS author_username,
         u.team AS author_team,
         COALESCE(SUM(CASE WHEN r.state = 'coming' THEN 1 END), 0) AS rsvp_coming,
         COALESCE(SUM(CASE WHEN r.state = 'here'   THEN 1 END), 0) AS rsvp_here,
         COALESCE(SUM(CASE WHEN r.state = 'done'   THEN 1 END), 0) AS rsvp_done
    FROM flares f
    -- The status predicate belongs in the JOIN, not a WHERE: this is a LEFT
    -- JOIN, and moving it out would turn "flare at a POI that has since been
    -- archived" into "flare dropped from the board entirely". Here it degrades
    -- to a flare with no location, which is the honest answer — the flare is
    -- still real, we just should not link to a POI that is no longer public.
    LEFT JOIN pois p ON p.id = f.poi_id AND p.status = 'published'
    LEFT JOIN users u ON u.id = f.created_by
    LEFT JOIN flare_rsvps r ON r.flare_id = f.id
`;

function toFlare(row: FlareRow): Flare {
  return {
    id: row.id,
    kind: row.kind,
    boss: row.boss,
    tier: row.tier,
    needed: row.needed,
    note: row.note,
    poi:
      row.poi_id !== null && row.poi_slug && row.poi_name && row.poi_type
        ? {
            id: row.poi_id,
            slug: row.poi_slug,
            name: row.poi_name,
            type: row.poi_type,
            lat: row.poi_lat ?? 0,
            lng: row.poi_lng ?? 0,
          }
        : null,
    author:
      row.author_id !== null
        ? {
            id: row.author_id,
            name:
              row.author_trainer_name ?? row.author_global_name ?? row.author_username ?? 'Trainer',
            team: row.author_team,
          }
        : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    closedAt: row.closed_at,
    rsvps: {
      coming: Number(row.rsvp_coming),
      here: Number(row.rsvp_here),
      done: Number(row.rsvp_done),
    },
  };
}

/**
 * Everything currently burning: not closed by hand, not yet expired.
 *
 * `limit` is a safety valve rather than pagination — the board is a live view,
 * and a community that posts more than 60 open flares at once has a spam
 * problem, not a paging problem.
 */
export async function listActiveFlares(
  db: D1Database,
  now: string = isoNow(),
  limit = 60,
): Promise<Flare[]> {
  const res = await db
    .prepare(
      `${SELECT_FLARE}
        WHERE f.closed_at IS NULL AND f.expires_at > ?1
        GROUP BY f.id
        ORDER BY f.created_at DESC
        LIMIT ?2`,
    )
    .bind(now, limit)
    .all<FlareRow>();

  return res.results.map(toFlare);
}

/** A single flare regardless of state — used to build broadcast payloads. */
export async function getFlare(db: D1Database, id: number): Promise<Flare | null> {
  const row = await db
    .prepare(`${SELECT_FLARE} WHERE f.id = ?1 GROUP BY f.id`)
    .bind(id)
    .first<FlareRow>();
  return row ? toFlare(row) : null;
}

export interface FlareOwnership {
  id: number;
  created_by: number | null;
  expires_at: string;
  closed_at: string | null;
  /** Which fields an edit is allowed to touch depends on the kind. */
  kind: FlareKind;
  /** Null when Discord is not configured, or the post did not come back. */
  discord_message_id: string | null;
}

/** The raw row, for authorisation checks that need `created_by`. */
export async function getFlareOwnership(
  db: D1Database,
  id: number,
): Promise<FlareOwnership | null> {
  return db
    .prepare(
      'SELECT id, created_by, expires_at, closed_at, kind, discord_message_id FROM flares WHERE id = ?1',
    )
    .bind(id)
    .first<FlareOwnership>();
}

/** A flare whose Discord embed still needs striking through. */
export interface PendingDiscordClose {
  id: number;
  discord_message_id: string;
  /** Null means it lapsed on its own rather than being stood down. */
  closed_at: string | null;
}

/**
 * Atomically take ownership of the flares whose embeds still owe Discord an
 * edit, and return them.
 *
 * The claim and the select are ONE statement on purpose. This runs off the read
 * path, so several requests can be in here at the same moment; a
 * select-then-update would let two of them read the same row and edit the same
 * Discord message twice. Writing `discord_closed_at` as part of the selecting
 * statement means the second caller simply sees no rows.
 *
 * The consequence is that a row is marked settled *before* we know whether
 * Discord accepted the edit — so a retryable failure has to hand it back with
 * `releaseFlareDiscordClose`. That is the right way round: claiming first risks
 * a delayed edit, claiming last risks a duplicate one, and a duplicate edit is
 * the one users actually see.
 *
 * `limit` bounds a single pass so a backlog cannot turn one page load into
 * hundreds of outbound requests.
 */
export async function claimFlaresForDiscordClose(
  db: D1Database,
  now: string,
  limit: number,
  onlyId?: number,
): Promise<PendingDiscordClose[]> {
  const res = await db
    .prepare(
      `UPDATE flares
          SET discord_closed_at = ?1
        WHERE id IN (
          SELECT id FROM flares
           WHERE discord_message_id IS NOT NULL
             AND discord_closed_at IS NULL
             AND (closed_at IS NOT NULL OR expires_at <= ?1)
             AND (?2 IS NULL OR id = ?2)
           ORDER BY expires_at
           LIMIT ?3)
      RETURNING id, discord_message_id, closed_at`,
    )
    .bind(now, onlyId ?? null, limit)
    .all<PendingDiscordClose>();
  return res.results ?? [];
}

/**
 * Hand a claimed flare back so a later sweep retries it.
 *
 * Only for failures that could plausibly succeed later — a rate limit or a
 * Discord outage. A message that is genuinely gone stays settled, or every
 * sweep from now until the heat death of the universe re-attempts it.
 */
export async function releaseFlareDiscordClose(db: D1Database, id: number): Promise<void> {
  await db
    .prepare('UPDATE flares SET discord_closed_at = NULL WHERE id = ?1')
    .bind(id)
    .run();
}

/**
 * The viewer's own RSVP per flare.
 *
 * Deliberately separate from `listActiveFlares`: flare rows are broadcast
 * verbatim to every connected socket, so anything viewer-specific has to stay
 * out of them or one trainer's board would show another's answers.
 */
export async function getViewerRsvps(
  db: D1Database,
  userId: number,
): Promise<Record<number, FlareRsvpState>> {
  const res = await db
    .prepare(
      `SELECT r.flare_id, r.state
         FROM flare_rsvps r
         JOIN flares f ON f.id = r.flare_id
        WHERE r.user_id = ?1 AND f.closed_at IS NULL AND f.expires_at > ?2`,
    )
    .bind(userId, isoNow())
    .all<{ flare_id: number; state: FlareRsvpState }>();

  const mine: Record<number, FlareRsvpState> = {};
  for (const row of res.results) mine[row.flare_id] = row.state;
  return mine;
}

/**
 * True when this trainer already has the same kind of flare open at the same
 * place. Two "raid at the Campsite" posts thirty seconds apart are a
 * double-tap, not two raids.
 */
export async function hasDuplicateFlare(
  db: D1Database,
  userId: number,
  kind: FlareKind,
  poiId: number | null,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM flares
        WHERE created_by = ?1 AND kind = ?2
          -- SQLite's IS compares NULLs as equal, so this matches a
          -- location-less flare against another location-less one too.
          AND poi_id IS ?3
          AND closed_at IS NULL AND expires_at > ?4
        LIMIT 1`,
    )
    .bind(userId, kind, poiId, isoNow())
    .first<{ hit: number }>();
  return row !== null;
}
