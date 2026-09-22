/**
 * Row factories for the Worker tests.
 *
 * Every function writes real rows into the per-test D1 and returns what came
 * back, so a test asserts against the same shape the app reads. They take the
 * database first because that is the only argument they all need, and it keeps
 * the call sites uniform; everything else is optional and defaulted.
 *
 * Sessions are the part worth reading before using this module. The cookie
 * carries a random token and `sessions.id` holds its SHA-256 — `seedSession`
 * calls the app's own `createSession` rather than reimplementing that, so there
 * is exactly one scheme in the repo and a test cannot accidentally prove
 * something about a second one. Overrides are applied afterwards with an
 * UPDATE, which is also how an aged session is made.
 *
 * One deviation from the obvious signature: `asUser` takes the database, so it
 * can mint the session for you in a single call. `asToken` is the synchronous
 * form for when you already hold a token.
 *
 * `seedAdminCredential` follows the same rule for the same reason: it calls the
 * app's own `hashPassword`, so a test cannot prove something about a hashing
 * scheme that does not ship. Its default iteration count is the schema's floor
 * rather than the production constant, which is only possible because the cost
 * is stored per row.
 *
 * The other thing in here is not a factory at all: `jsonRequest` and its two
 * signed-in forms, which exist because every non-GET request through
 * `SELF.fetch` needs an `Origin` header or Astro refuses it. That is a fact
 * about the harness rather than about any one route, so it belongs beside the
 * request builders instead of being rediscovered in each suite.
 */

import { hashPassword } from '~/lib/auth/password';
import { createSession, SESSION_COOKIE, sha256 } from '~/lib/auth/session';
import type { Role, Team } from '~/lib/auth/types';
import { expiryFor, type FlareKind, type FlareRsvpState } from '~/lib/db/flares';
import type { PoiType } from '~/lib/db/map';

/* --------------------------------------------------------------- utilities */

/** Anything with an `id`, or the id itself — so `seedRsvp(db, flare, user)` reads naturally. */
export type Ref = number | { id: number };

export function refId(ref: Ref): number {
  return typeof ref === 'number' ? ref : ref.id;
}

/**
 * The timestamp shape every table uses: ISO-8601 UTC with the milliseconds
 * stripped, matching `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`. Comparisons in
 * this schema are lexicographic on TEXT, so a stray `.000` sorts wrong.
 */
export function iso(at: Date | number = Date.now()): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `isoIn(-60)` is a minute ago; `isoIn(3600)` is an hour away. */
export function isoIn(seconds: number): string {
  return iso(Date.now() + seconds * 1000);
}

/** The `sessions.id` a given cookie token hashes to. */
export function sessionIdFor(token: string): Promise<string> {
  return sha256(token);
}

/**
 * Makes the unique columns unique without the caller having to think about it.
 * Per-isolate, and each test file gets its own isolate, so the numbers stay
 * small and readable in failure output.
 */
let sequence = 0;
function next(): number {
  return ++sequence;
}

/* ------------------------------------------------------------------- users */

export interface SeedUserOptions {
  discordId?: string;
  username?: string;
  globalName?: string | null;
  avatarHash?: string | null;
  role?: Role;
  team?: Team | null;
  trainerName?: string | null;
  trainerCode?: string | null;
  /** The schema only accepts 1-80. */
  trainerLevel?: number | null;
  isBanned?: boolean;
  banReason?: string | null;
  createdAt?: string;
  lastSeenAt?: string | null;
  /** Pins the role against Discord — see `upsertUser`'s CASE. */
  roleLocked?: boolean;
}

/** A `users` row exactly as D1 returns it. */
export interface SeededUser {
  id: number;
  discord_id: string;
  username: string;
  global_name: string | null;
  avatar_hash: string | null;
  team: Team | null;
  trainer_code: string | null;
  trainer_level: number | null;
  trainer_name: string | null;
  role: Role;
  is_banned: number;
  ban_reason: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  role_locked: number;
}

export async function seedUser(db: D1Database, opts: SeedUserOptions = {}): Promise<SeededUser> {
  const n = next();
  const createdAt = opts.createdAt ?? iso();

  const row = await db
    .prepare(
      `INSERT INTO users (discord_id, username, global_name, avatar_hash, team, trainer_code,
                          trainer_level, trainer_name, role, is_banned, ban_reason,
                          created_at, updated_at, last_seen_at, role_locked)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14)
       RETURNING *`,
    )
    .bind(
      opts.discordId ?? `discord-${n}`,
      opts.username ?? `trainer${n}`,
      opts.globalName === undefined ? null : opts.globalName,
      opts.avatarHash ?? null,
      opts.team ?? null,
      opts.trainerCode ?? null,
      opts.trainerLevel ?? null,
      opts.trainerName ?? null,
      opts.role ?? 'member',
      opts.isBanned ? 1 : 0,
      opts.banReason ?? null,
      createdAt,
      opts.lastSeenAt ?? null,
      opts.roleLocked ? 1 : 0,
    )
    .first<SeededUser>();

  if (!row) throw new Error('seedUser: insert returned no row');
  return row;
}

/* ---------------------------------------------------------------- sessions */

export interface SeedSessionOptions {
  /** Defaults to the app's own fortnight. Pass a past value to test expiry. */
  expiresAt?: string;
  /**
   * Back-dates the row. `touchSession` decides whether to slide from
   * `expires_at`, not from this, so ageing a session means passing both — but
   * a test asserting "nothing was written" needs a `created_at` to compare.
   */
  createdAt?: string;
  userAgent?: string | null;
}

/**
 * Creates a session for `user` and returns the raw cookie token. The token is
 * never stored: `sessions.id` is its SHA-256, so this call is the only moment
 * it exists. Use `sessionIdFor(token)` when a test needs the row's key.
 */
export async function seedSession(
  db: D1Database,
  user: Ref,
  opts: SeedSessionOptions = {},
): Promise<string> {
  const token = await createSession(db, refId(user), opts.userAgent ?? null);
  const id = await sha256(token);

  if (opts.expiresAt !== undefined) {
    await db
      .prepare('UPDATE sessions SET expires_at = ?2 WHERE id = ?1')
      .bind(id, opts.expiresAt)
      .run();
  }
  if (opts.createdAt !== undefined) {
    await db
      .prepare('UPDATE sessions SET created_at = ?2 WHERE id = ?1')
      .bind(id, opts.createdAt)
      .run();
  }

  return token;
}

/** The `Cookie` header value the app's middleware reads a session out of. */
export function authCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

/** A Request carrying a token you already hold. */
export function asToken(token: string, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('cookie', authCookie(token));
  return new Request(url, { ...init, headers });
}

/**
 * Mints a session for `user` and returns a Request signed in as them — the
 * one-call form, for `SELF.fetch(await asUser(env.DB, admin, url))`.
 */
export async function asUser(
  db: D1Database,
  user: Ref,
  url: string,
  init: RequestInit = {},
): Promise<Request> {
  return asToken(await seedSession(db, user), url, init);
}

/* -------------------------------------------------------- admin credentials */

export interface SeedAdminCredentialOptions {
  username?: string;
  password?: string;
  /**
   * Defaults to the schema's floor rather than to `DEFAULT_ITERATIONS`, so a
   * suite of twenty logins is twenty cheap derivations instead of twenty
   * hundred-thousand-round ones. This works *only* because the cost lives in
   * the row: `verifyPassword` reads the count it finds rather than assuming
   * one, which is the same property that lets the constant be raised in
   * production without invalidating an admin's existing hash.
   *
   * It is 10,000 and not lower because two independent floors say so — the
   * `CHECK (iterations >= 10000)` in `0004_owner_password.sql`, which refuses
   * the INSERT outright, and the identical check inside `verifyPassword`, which
   * would answer `false` for anything cheaper even if the row existed.
   */
  iterations?: number;
  failedAttempts?: number;
  lockedUntil?: string | null;
  lastFailedAt?: string | null;
  lastSuccessAt?: string | null;
  /**
   * Written over the real values after the insert, for the corrupt-row cases.
   * `salt` and `hash` are unconstrained TEXT, so a non-base64url salt or a
   * truncated hash is genuinely reachable in production and worth testing;
   * `algorithm` and `iterations` are not, because their CHECK constraints
   * refuse a bad value on INSERT and on UPDATE alike.
   */
  salt?: string;
  hash?: string;
}

export interface SeededCredential {
  username: string;
  /** The plaintext, so a test can sign in with it. Never stored. */
  password: string;
  userId: number;
  iterations: number;
}

/**
 * Gives `user` a password credential.
 *
 * Calls the app's own `hashPassword`, for the same reason `seedSession` calls
 * the real `createSession`: there is one hashing scheme in this repo, and a
 * factory that reimplemented it could prove something true about a second one
 * that does not ship. Overrides are applied afterwards with an UPDATE, which is
 * also how a locked or corrupt row is made.
 */
export async function seedAdminCredential(
  db: D1Database,
  user: Ref,
  opts: SeedAdminCredentialOptions = {},
): Promise<SeededCredential> {
  const n = next();
  const userId = refId(user);
  const username = opts.username ?? `admin${n}`;
  const password = opts.password ?? `seeded passphrase ${n} long enough`;
  const iterations = opts.iterations ?? 10_000;

  const stored = await hashPassword(password, iterations);

  await db
    .prepare(
      `INSERT INTO admin_credentials
         (user_id, username, algorithm, iterations, salt, hash,
          failed_attempts, locked_until, last_failed_at, last_success_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      userId,
      username,
      stored.algorithm,
      stored.iterations,
      opts.salt ?? stored.salt,
      opts.hash ?? stored.hash,
      opts.failedAttempts ?? 0,
      opts.lockedUntil ?? null,
      opts.lastFailedAt ?? null,
      opts.lastSuccessAt ?? null,
    )
    .run();

  return { username, password, userId, iterations };
}

/** The `admin_credentials` row as D1 returns it — for asserting on the state. */
export interface SeededCredentialRow {
  user_id: number;
  username: string;
  algorithm: string;
  iterations: number;
  salt: string;
  hash: string;
  failed_attempts: number;
  locked_until: string | null;
  last_failed_at: string | null;
  last_success_at: string | null;
}

export async function readCredential(
  db: D1Database,
  user: Ref,
): Promise<SeededCredentialRow | null> {
  return db
    .prepare('SELECT * FROM admin_credentials WHERE user_id = ?1')
    .bind(refId(user))
    .first<SeededCredentialRow>();
}

/* --------------------------------------------------------- write requests */

/**
 * `RequestInit` with the body given as a value to serialise rather than a
 * string to write. `body` is still there for the cases `json` cannot reach —
 * malformed JSON, a form encoding, no body at all.
 */
export interface JsonInit extends Omit<RequestInit, 'body'> {
  /** Serialised, with a matching `content-type`. */
  json?: unknown;
  /** Sent verbatim. Wins over `json` if both are given. */
  body?: BodyInit | null;
}

/** The shared part: everything that is true of the request before the cookie. */
function writeInit(url: string, init: JsonInit): RequestInit {
  const { json, body, headers: given, ...rest } = init;
  const headers = new Headers(given);
  // Taken from the URL rather than passed in, so the two cannot drift apart.
  headers.set('origin', new URL(url).origin);

  // Only when we are the ones serialising. A body handed over verbatim is the
  // caller's to describe, and labelling it would be actively wrong for the
  // commonest case: `FormData` needs the runtime to set its own boundary.
  if (body === undefined && json !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  // POST by default, because that is the verb this exists for; `method` still
  // overrides, so one builder can cover a whole surface including its reads.
  return {
    method: 'POST',
    ...rest,
    headers,
    body: body !== undefined ? body : json === undefined ? undefined : JSON.stringify(json),
  };
}

/**
 * A signed-out write: `SELF.fetch(jsonRequest(url, { json: { … } }))`.
 *
 * Astro's CSRF check compares `Origin` against the request URL and answers 403
 * when they differ, so a POST built by hand fails before the route runs — and
 * fails in a shape that hides what happened, because that body is plain text
 * and `res.json()` throws on it rather than reporting a status. A browser
 * always sends the header; `SELF.fetch` never does.
 *
 * `url` is absolute, as `SELF.fetch` requires anyway.
 */
export function jsonRequest(url: string, init: JsonInit = {}): Request {
  return new Request(url, writeInit(url, init));
}

/** The same, carrying a token you already hold. */
export function jsonAsToken(token: string, url: string, init: JsonInit = {}): Request {
  return asToken(token, url, writeInit(url, init));
}

/**
 * The same, signed in as `user` — an authenticated write in one call:
 * `SELF.fetch(await jsonAsUser(env.DB, admin, url, { json: { … } }))`.
 */
export async function jsonAsUser(
  db: D1Database,
  user: Ref,
  url: string,
  init: JsonInit = {},
): Promise<Request> {
  return asUser(db, user, url, writeInit(url, init));
}

/* ------------------------------------------------------------------- zones */

export interface SeedZoneOptions {
  slug?: string;
  name?: string;
  blurb?: string | null;
  centerLat?: number;
  centerLng?: number;
  defaultZoom?: number;
  minZoom?: number | null;
  maxZoom?: number | null;
  boundsJson?: string | null;
  /**
   * Defaults to true, because the map reads the default zone when no slug is
   * given and a test that just wants "a zone" almost always wants that one. A
   * partial unique index allows only one, so setting this clears any existing
   * default first rather than failing the insert.
   */
  isDefault?: boolean;
  sort?: number;
}

export interface SeededZone {
  id: number;
  slug: string;
  name: string;
  blurb: string | null;
  center_lat: number;
  center_lng: number;
  default_zoom: number;
  min_zoom: number | null;
  max_zoom: number | null;
  bounds_json: string | null;
  is_default: number;
  sort: number;
  created_at: string;
  updated_at: string;
}

export async function seedZone(db: D1Database, opts: SeedZoneOptions = {}): Promise<SeededZone> {
  const n = next();
  const isDefault = opts.isDefault ?? true;

  if (isDefault) {
    await db.prepare('UPDATE zones SET is_default = 0 WHERE is_default = 1').run();
  }

  const row = await db
    .prepare(
      `INSERT INTO zones (slug, name, blurb, center_lat, center_lng, default_zoom,
                          min_zoom, max_zoom, bounds_json, is_default, sort)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       RETURNING *`,
    )
    .bind(
      opts.slug ?? `zone-${n}`,
      opts.name ?? `Zone ${n}`,
      opts.blurb ?? null,
      // Spring Lake Park, which is the only zone the real site has.
      opts.centerLat ?? 33.4735,
      opts.centerLng ?? -94.0815,
      opts.defaultZoom ?? 16,
      opts.minZoom ?? null,
      opts.maxZoom ?? null,
      opts.boundsJson ?? null,
      isDefault ? 1 : 0,
      opts.sort ?? 0,
    )
    .first<SeededZone>();

  if (!row) throw new Error('seedZone: insert returned no row');
  return row;
}

/* -------------------------------------------------------------------- pois */

export type PoiStatus = 'published' | 'pending' | 'rejected' | 'archived';

export interface SeedPoiOptions {
  /** Omitted means the current default zone, or a fresh one if there is none. */
  zoneId?: number;
  slug?: string;
  name?: string;
  type?: PoiType;
  description?: string | null;
  lat?: number;
  lng?: number;
  isCampsite?: boolean;
  isMeetupSpot?: boolean;
  isExEligible?: boolean;
  sponsor?: string | null;
  /** Anything but 'published' is off the map, and 422s a flare pointed at it. */
  status?: PoiStatus;
  heroMediaId?: number | null;
  sort?: number;
  createdBy?: number | null;
}

export interface SeededPoi {
  id: number;
  zone_id: number;
  slug: string;
  name: string;
  type: PoiType;
  description: string | null;
  lat: number;
  lng: number;
  is_campsite: number;
  is_meetup_spot: number;
  is_ex_eligible: number;
  sponsor: string | null;
  status: PoiStatus;
  hero_media_id: number | null;
  sort: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

async function defaultZoneId(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT id FROM zones WHERE is_default = 1').first<{ id: number }>();
  return row?.id ?? (await seedZone(db)).id;
}

export async function seedPoi(db: D1Database, opts: SeedPoiOptions = {}): Promise<SeededPoi> {
  const n = next();
  const zoneId = opts.zoneId ?? (await defaultZoneId(db));

  const row = await db
    .prepare(
      `INSERT INTO pois (zone_id, slug, name, type, description, lat, lng, is_campsite,
                         is_meetup_spot, is_ex_eligible, sponsor, status, hero_media_id,
                         sort, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       RETURNING *`,
    )
    .bind(
      zoneId,
      opts.slug ?? `poi-${n}`,
      opts.name ?? `Point ${n}`,
      opts.type ?? 'gym',
      opts.description ?? null,
      opts.lat ?? 33.4735,
      opts.lng ?? -94.0815,
      opts.isCampsite ? 1 : 0,
      opts.isMeetupSpot ? 1 : 0,
      opts.isExEligible ? 1 : 0,
      opts.sponsor ?? null,
      opts.status ?? 'published',
      opts.heroMediaId ?? null,
      opts.sort ?? 0,
      opts.createdBy ?? null,
    )
    .first<SeededPoi>();

  if (!row) throw new Error('seedPoi: insert returned no row');
  return row;
}

/* ------------------------------------------------------------------ flares */

export interface SeedFlareOptions {
  kind?: FlareKind;
  zoneId?: number | null;
  poiId?: number | null;
  boss?: string | null;
  tier?: string | null;
  needed?: number | null;
  note?: string | null;
  createdBy?: number | null;
  createdAt?: string;
  /** Shorthand for an `expiresAt` in the past — the flare has dropped off the board. */
  expired?: boolean;
  expiresAt?: string;
  /** Shorthand for a `closedAt` of now — the author retired it by hand. */
  closed?: boolean;
  closedAt?: string | null;
  /** Present means Discord holds an embed for this flare that may need editing. */
  discordMessageId?: string | null;
  /**
   * Non-null means the embed is settled and the closure sweep will leave it
   * alone; null alongside a message id means it still owes Discord an edit. See
   * migrations/0002_flare_discord_close.sql.
   */
  discordClosedAt?: string | null;
}

export interface SeededFlare {
  id: number;
  zone_id: number | null;
  poi_id: number | null;
  kind: FlareKind;
  boss: string | null;
  tier: string | null;
  needed: number | null;
  note: string | null;
  created_by: number | null;
  created_at: string;
  expires_at: string;
  closed_at: string | null;
  discord_message_id: string | null;
  discord_closed_at: string | null;
}

export async function seedFlare(db: D1Database, opts: SeedFlareOptions = {}): Promise<SeededFlare> {
  const kind = opts.kind ?? 'raid';
  // The app's own per-kind lifetime, so a seeded flare ages like a real one.
  const expiresAt = opts.expiresAt ?? (opts.expired ? isoIn(-60) : expiryFor(kind));
  const closedAt = opts.closedAt !== undefined ? opts.closedAt : opts.closed ? iso() : null;

  const row = await db
    .prepare(
      `INSERT INTO flares (zone_id, poi_id, kind, boss, tier, needed, note, created_by,
                           created_at, expires_at, closed_at, discord_message_id,
                           discord_closed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       RETURNING *`,
    )
    .bind(
      opts.zoneId ?? null,
      opts.poiId ?? null,
      kind,
      opts.boss ?? null,
      opts.tier ?? null,
      opts.needed ?? null,
      opts.note ?? null,
      opts.createdBy ?? null,
      opts.createdAt ?? iso(),
      expiresAt,
      closedAt,
      opts.discordMessageId ?? null,
      opts.discordClosedAt ?? null,
    )
    .first<SeededFlare>();

  if (!row) throw new Error('seedFlare: insert returned no row');
  return row;
}

/* ------------------------------------------------------------------- rsvps */

export interface SeededRsvp {
  flare_id: number;
  user_id: number;
  state: FlareRsvpState;
  updated_at: string;
}

export async function seedRsvp(
  db: D1Database,
  flare: Ref,
  user: Ref,
  state: FlareRsvpState = 'coming',
): Promise<SeededRsvp> {
  const row = await db
    .prepare(
      `INSERT INTO flare_rsvps (flare_id, user_id, state) VALUES (?1, ?2, ?3)
       ON CONFLICT (flare_id, user_id) DO UPDATE SET state = excluded.state
       RETURNING *`,
    )
    .bind(refId(flare), refId(user), state)
    .first<SeededRsvp>();

  if (!row) throw new Error('seedRsvp: insert returned no row');
  return row;
}

/* ------------------------------------------------------------------- posts */

export interface SeedPostOptions {
  slug?: string;
  title?: string;
  excerpt?: string | null;
  bodyMd?: string;
  heroMediaId?: number | null;
  status?: 'draft' | 'scheduled' | 'published' | 'archived';
  pinned?: boolean;
  authorId?: number | null;
  publishedAt?: string | null;
  /**
   * The author ticked "also announce to Discord". Left off by default, because
   * a seeded row that asks for an announcement makes every later read of it a
   * potential outbound call — see migrations/0003_announcements.sql.
   */
  announceRequested?: boolean;
  /**
   * NULL means the row still owes Discord a message. Defaulted to *now* rather
   * than null so a seeded post is settled and the announcement sweep passes
   * over it, which is what a test about authorisation wants.
   */
  announcedAt?: string | null;
}

export interface SeededPost {
  id: number;
  slug: string;
  title: string;
  excerpt: string | null;
  body_md: string;
  hero_media_id: number | null;
  status: string;
  pinned: number;
  author_id: number | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  announce_requested: number;
  announced_at: string | null;
}

export async function seedPost(db: D1Database, opts: SeedPostOptions = {}): Promise<SeededPost> {
  const n = next();

  const row = await db
    .prepare(
      `INSERT INTO posts (slug, title, excerpt, body_md, hero_media_id, status, pinned,
                          author_id, published_at, announce_requested, announced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       RETURNING *`,
    )
    .bind(
      opts.slug ?? `post-${n}`,
      opts.title ?? `Post ${n}`,
      opts.excerpt ?? null,
      opts.bodyMd ?? '',
      opts.heroMediaId ?? null,
      opts.status ?? 'draft',
      opts.pinned ? 1 : 0,
      opts.authorId ?? null,
      opts.publishedAt ?? null,
      opts.announceRequested ? 1 : 0,
      opts.announcedAt === undefined ? iso() : opts.announcedAt,
    )
    .first<SeededPost>();

  if (!row) throw new Error('seedPost: insert returned no row');
  return row;
}

/* ----------------------------------------------------------------- meetups */

export interface SeedMeetupOptions {
  zoneId?: number | null;
  slug?: string;
  title?: string;
  descriptionMd?: string | null;
  /** ISO-8601 UTC. Defaults to an hour out, so the meetup is upcoming. */
  startsAt?: string;
  endsAt?: string | null;
  tz?: string;
  poiId?: number | null;
  locationText?: string | null;
  campfireUrl?: string | null;
  recurrenceRule?: string | null;
  status?: 'draft' | 'published' | 'cancelled';
  createdBy?: number | null;
  /** See `SeedPostOptions.announceRequested` — same column, same reasoning. */
  announceRequested?: boolean;
  announcedAt?: string | null;
}

export interface SeededMeetup {
  id: number;
  zone_id: number | null;
  slug: string;
  title: string;
  description_md: string | null;
  starts_at: string;
  ends_at: string | null;
  tz: string;
  poi_id: number | null;
  location_text: string | null;
  campfire_url: string | null;
  hero_media_id: number | null;
  recurrence_rule: string | null;
  status: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  announce_requested: number;
  announced_at: string | null;
}

export async function seedMeetup(
  db: D1Database,
  opts: SeedMeetupOptions = {},
): Promise<SeededMeetup> {
  const n = next();

  const row = await db
    .prepare(
      `INSERT INTO meetups (zone_id, slug, title, description_md, starts_at, ends_at, tz,
                            poi_id, location_text, campfire_url, recurrence_rule, status,
                            created_by, announce_requested, announced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       RETURNING *`,
    )
    .bind(
      opts.zoneId ?? null,
      opts.slug ?? `meetup-${n}`,
      opts.title ?? `Meetup ${n}`,
      opts.descriptionMd ?? null,
      opts.startsAt ?? isoIn(3600),
      opts.endsAt ?? null,
      opts.tz ?? 'America/Chicago',
      opts.poiId ?? null,
      opts.locationText ?? null,
      opts.campfireUrl ?? null,
      opts.recurrenceRule ?? null,
      opts.status ?? 'published',
      opts.createdBy ?? null,
      opts.announceRequested ? 1 : 0,
      opts.announcedAt === undefined ? iso() : opts.announcedAt,
    )
    .first<SeededMeetup>();

  if (!row) throw new Error('seedMeetup: insert returned no row');
  return row;
}

/* ------------------------------------------------------------------- media */

export interface SeedMediaOptions {
  r2Key?: string;
  mime?: string;
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
  alt?: string | null;
  caption?: string | null;
  credit?: string | null;
  sourceTitle?: string | null;
  sourceDate?: string | null;
  sourceUrl?: string | null;
  /** The schema only accepts these four. */
  kind?: 'photo' | 'community_photo' | 'doc' | 'import';
  zoneId?: number | null;
  lat?: number | null;
  lng?: number | null;
  uploadedBy?: number | null;
}

export interface SeededMedia {
  id: number;
  r2_key: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  alt: string | null;
  caption: string | null;
  credit: string | null;
  source_title: string | null;
  source_date: string | null;
  source_url: string | null;
  kind: string;
  zone_id: number | null;
  lat: number | null;
  lng: number | null;
  uploaded_by: number | null;
  created_at: string;
}

/**
 * A `media` row only. The bytes it describes are not put into R2 — nothing that
 * reads a row needs the object to exist, and a factory that wrote to both would
 * make every test that seeds an image pay for one.
 */
export async function seedMedia(db: D1Database, opts: SeedMediaOptions = {}): Promise<SeededMedia> {
  const n = next();

  const row = await db
    .prepare(
      `INSERT INTO media (r2_key, mime, width, height, bytes, alt, caption, credit,
                          source_title, source_date, source_url, kind, zone_id, lat, lng,
                          uploaded_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       RETURNING *`,
    )
    .bind(
      opts.r2Key ?? `uploads/media-${n}.png`,
      opts.mime ?? 'image/png',
      opts.width ?? null,
      opts.height ?? null,
      opts.bytes ?? null,
      opts.alt ?? null,
      opts.caption ?? null,
      opts.credit ?? null,
      opts.sourceTitle ?? null,
      opts.sourceDate ?? null,
      opts.sourceUrl ?? null,
      opts.kind ?? 'photo',
      opts.zoneId ?? null,
      opts.lat ?? null,
      opts.lng ?? null,
      opts.uploadedBy ?? null,
    )
    .first<SeededMedia>();

  if (!row) throw new Error('seedMedia: insert returned no row');
  return row;
}
