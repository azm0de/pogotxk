/**
 * The admin surface, written down once: every route, every method it exports,
 * and what each of six callers must get back.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TABLE IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * An authorisation matrix is only worth anything if it is exhaustive, and the
 * usual way it stops being exhaustive is that somebody adds a route and nobody
 * adds a row. So the table is checked against the filesystem rather than
 * trusted: `api-matrix.test.ts` globs `src/pages/api/admin/**` , reads the HTTP
 * method exports off each module, and fails if a single (file, method) pair is
 * missing from `ADMIN_ROUTES`. Adding a route without a row breaks the build;
 * adding the row forces its author to state the outcome for all six callers,
 * and an unguarded route cannot survive that.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXPECTATION NAMES A GUARD AND NOT JUST A NUMBER
 * ---------------------------------------------------------------------------
 *
 * Three different guards sit in front of this surface and two of them answer
 * 401. The middleware refuses a signed-out caller with `{error: 'Forbidden'}`;
 * `requireImportToken` refuses one with `{error: 'Unauthorized'}` and a
 * `WWW-Authenticate` challenge. A test that only compared the number would pass
 * if the import exemption widened to swallow a route the middleware used to
 * protect — the status would not move, and the guard doing the work would have
 * silently changed. `Answerer` is what makes that visible.
 */

import { env } from 'cloudflare:test';
import {
  jsonAsUser,
  jsonRequest,
  seedMedia,
  seedMeetup,
  seedPoi,
  seedPost,
  seedUser,
  seedZone,
  type JsonInit,
  type SeededMedia,
  type SeededMeetup,
  type SeededPoi,
  type SeededPost,
} from '../helpers/factories';

export const ORIGIN = 'https://pogotxk.test';

/* ----------------------------------------------------------------- callers */

/**
 * The five role states plus a banned account.
 *
 * `banned admin` is the one that looks redundant and is not: `getSessionUser`
 * returns undefined for a banned row, so the highest-privileged account on the
 * site must come out the far side of the middleware indistinguishable from a
 * stranger. Anything less than that means a ban does not take effect until the
 * session expires.
 */
export const CALLERS = [
  'anonymous',
  'guest',
  'member',
  'ambassador',
  'admin',
  'banned admin',
] as const;

export type Caller = (typeof CALLERS)[number];

/**
 * A Request for `url` carrying whatever credentials `caller` implies.
 *
 * Built through `jsonRequest`/`jsonAsUser` rather than by hand so the `Origin`
 * header comes from the shared helper: Astro's CSRF check answers 403 with a
 * non-JSON body when it is missing, which in a suite about authorisation reads
 * exactly like a refusal and is not one.
 */
export async function requestAs(
  caller: Caller,
  url: string,
  init: JsonInit = {},
): Promise<Request> {
  if (caller === 'anonymous') return jsonRequest(url, init);

  const user = await seedUser(
    env.DB,
    caller === 'banned admin' ? { role: 'admin', isBanned: true } : { role: caller },
  );
  return jsonAsUser(env.DB, user, url, init);
}

/* ---------------------------------------------------------------- outcomes */

/**
 * Which guard produced the answer.
 *
 *   middleware   — the role gate in `src/middleware.ts`
 *   import-guard — `requireImportToken`, reached because the path is exempt
 *                  from the role gate or because the route asks for it as well
 *   role-check   — `requireRole` inside the route, stricter than the floor
 *   route        — every guard passed and the handler answered
 */
export type Answerer = 'middleware' | 'import-guard' | 'role-check' | 'route';

export interface Outcome {
  readonly status: number;
  readonly by: Answerer;
  /** For `role-check` only: the message `requireRole` throws. */
  readonly message?: string;
}

/**
 * The ordinary shape: the middleware's `ambassador` floor and nothing further.
 * `ok` is what the handler answers once the caller is through.
 */
function ambassadorFloor(ok: number): Record<Caller, Outcome> {
  return {
    anonymous: { status: 401, by: 'middleware' },
    guest: { status: 403, by: 'middleware' },
    member: { status: 403, by: 'middleware' },
    ambassador: { status: ok, by: 'route' },
    admin: { status: ok, by: 'route' },
    'banned admin': { status: 401, by: 'middleware' },
  };
}

/**
 * The floor, plus a second `requireRole` inside the handler. Only `?hard=1` on
 * POI delete uses this: it is irreversible and cascades to `poi_media`.
 */
function adminOnly(ok: number): Record<Caller, Outcome> {
  return {
    ...ambassadorFloor(ok),
    ambassador: { status: 403, by: 'role-check', message: 'Requires admin' },
  };
}

/**
 * The import endpoints. The middleware skips the role check entirely for the
 * `/api/admin/import-` prefix, so every one of these answers comes from the
 * route's own `requireImportAuth` — which short-circuits for an `admin` session
 * and for nothing else, ambassador included.
 */
function importGuarded(ok: number): Record<Caller, Outcome> {
  return {
    anonymous: { status: 401, by: 'import-guard' },
    guest: { status: 401, by: 'import-guard' },
    member: { status: 401, by: 'import-guard' },
    ambassador: { status: 401, by: 'import-guard' },
    admin: { status: ok, by: 'route' },
    'banned admin': { status: 401, by: 'import-guard' },
  };
}

/**
 * Both guards stacked. `config-check` is *not* import-prefixed, so the
 * middleware's floor applies first and only then does the route ask
 * `requireImportAuth` — which is why an ambassador gets past the middleware and
 * is refused by the route, with a different status and a different body than
 * the member one step below them.
 */
function middlewareThenImportGuard(ok: number): Record<Caller, Outcome> {
  return {
    ...ambassadorFloor(ok),
    ambassador: { status: 401, by: 'import-guard' },
  };
}

/* ------------------------------------------------------------------ routes */

export interface Fixtures {
  readonly poi: SeededPoi;
  readonly post: SeededPost;
  readonly meetup: SeededMeetup;
  readonly media: SeededMedia;
}

export interface AdminRoute {
  /** Reads as the test name: `GET /api/admin/pois`. */
  readonly name: string;
  /** Path relative to `src/pages/api/admin/`, for the coverage check. */
  readonly file: string;
  /** The exported handler name, likewise. */
  readonly method: string;
  /**
   * Built fresh per call rather than stored, because a `FormData` body cannot
   * be sent twice and `[id]` paths need a row that only exists inside the test.
   */
  build(fx: Fixtures): { path: string; init: JsonInit };
  readonly expect: Record<Caller, Outcome>;
}

/**
 * The bytes of a 2x3 PNG: signature, then an IHDR whose data is the size.
 *
 * The buffer is spelled out in the return type because `BlobPart` accepts only
 * an `ArrayBuffer`-backed view, and a bare `Uint8Array` widens to
 * `ArrayBufferLike` — which includes `SharedArrayBuffer` and so will not go
 * into a `File`.
 */
export function pngBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 2);
  view.setUint32(20, 3);
  return bytes;
}

/** `jsonRequest` defaults to POST, so a read has to say so. */
const GET_INIT: JsonInit = { method: 'GET' };

function send(method: string, json: unknown): JsonInit {
  return { method, json };
}

function del(): JsonInit {
  return { method: 'DELETE' };
}

function upload(): JsonInit {
  const form = new FormData();
  form.set('file', new File([pngBytes()], 'shot.png', { type: 'image/png' }), 'shot.png');
  form.set('alt', 'a very small square');
  // `body` rather than `json`, so the runtime sets the multipart boundary.
  return { method: 'POST', body: form };
}

/**
 * Every route under `/api/admin`, every method, and the answer owed to each of
 * the six callers.
 *
 * The bodies are deliberately valid. A route that refused an authorised caller
 * for a *validation* reason would report 400 or 422 and look, from a distance,
 * like a working authorisation boundary — so each success here is the real one
 * the handler produces when it does the work.
 */
export const ADMIN_ROUTES: readonly AdminRoute[] = [
  {
    name: 'GET /api/admin/pois',
    file: 'pois/index.ts',
    method: 'GET',
    build: () => ({ path: '/api/admin/pois', init: GET_INIT }),
    expect: ambassadorFloor(200),
  },
  {
    name: 'POST /api/admin/pois',
    file: 'pois/index.ts',
    method: 'POST',
    build: () => ({
      path: '/api/admin/pois',
      init: send('POST', { name: 'Fountain', type: 'pokestop', lat: 33.4735, lng: -94.0815 }),
    }),
    expect: ambassadorFloor(201),
  },
  {
    name: 'GET /api/admin/pois/:id',
    file: 'pois/[id].ts',
    method: 'GET',
    build: (fx) => ({ path: `/api/admin/pois/${fx.poi.id}`, init: GET_INIT }),
    expect: ambassadorFloor(200),
  },
  {
    name: 'PATCH /api/admin/pois/:id',
    file: 'pois/[id].ts',
    method: 'PATCH',
    build: (fx) => ({
      path: `/api/admin/pois/${fx.poi.id}`,
      init: send('PATCH', { name: 'Renamed Point' }),
    }),
    expect: ambassadorFloor(200),
  },
  {
    name: 'DELETE /api/admin/pois/:id',
    file: 'pois/[id].ts',
    method: 'DELETE',
    build: (fx) => ({ path: `/api/admin/pois/${fx.poi.id}`, init: del() }),
    // The soft delete: archives the row, and an ambassador may do it.
    expect: ambassadorFloor(204),
  },
  {
    name: 'DELETE /api/admin/pois/:id?hard=1',
    file: 'pois/[id].ts',
    method: 'DELETE',
    build: (fx) => ({ path: `/api/admin/pois/${fx.poi.id}?hard=1`, init: del() }),
    expect: adminOnly(204),
  },
  {
    name: 'GET /api/admin/meetups',
    file: 'meetups/index.ts',
    method: 'GET',
    build: () => ({ path: '/api/admin/meetups', init: GET_INIT }),
    expect: ambassadorFloor(200),
  },
  {
    name: 'POST /api/admin/meetups',
    file: 'meetups/index.ts',
    method: 'POST',
    build: () => ({
      path: '/api/admin/meetups',
      init: send('POST', { title: 'Wednesday walk', startsAtLocal: '2026-10-07T18:00' }),
    }),
    expect: ambassadorFloor(201),
  },
  {
    name: 'PATCH /api/admin/meetups/:id',
    file: 'meetups/[id].ts',
    method: 'PATCH',
    build: (fx) => ({
      path: `/api/admin/meetups/${fx.meetup.id}`,
      init: send('PATCH', { title: 'Thursday walk' }),
    }),
    expect: ambassadorFloor(200),
  },
  {
    name: 'DELETE /api/admin/meetups/:id',
    file: 'meetups/[id].ts',
    method: 'DELETE',
    build: (fx) => ({ path: `/api/admin/meetups/${fx.meetup.id}`, init: del() }),
    expect: ambassadorFloor(204),
  },
  {
    name: 'GET /api/admin/posts',
    file: 'posts/index.ts',
    method: 'GET',
    build: () => ({ path: '/api/admin/posts', init: GET_INIT }),
    expect: ambassadorFloor(200),
  },
  {
    name: 'POST /api/admin/posts',
    file: 'posts/index.ts',
    method: 'POST',
    build: () => ({
      path: '/api/admin/posts',
      init: send('POST', { title: 'Raid hour moved' }),
    }),
    expect: ambassadorFloor(201),
  },
  {
    name: 'GET /api/admin/posts/:id',
    file: 'posts/[id].ts',
    method: 'GET',
    build: (fx) => ({ path: `/api/admin/posts/${fx.post.id}`, init: GET_INIT }),
    expect: ambassadorFloor(200),
  },
  {
    name: 'PATCH /api/admin/posts/:id',
    file: 'posts/[id].ts',
    method: 'PATCH',
    build: (fx) => ({
      path: `/api/admin/posts/${fx.post.id}`,
      init: send('PATCH', { title: 'Raid hour moved again' }),
    }),
    expect: ambassadorFloor(200),
  },
  {
    name: 'DELETE /api/admin/posts/:id',
    file: 'posts/[id].ts',
    method: 'DELETE',
    build: (fx) => ({ path: `/api/admin/posts/${fx.post.id}`, init: del() }),
    expect: ambassadorFloor(204),
  },
  {
    name: 'GET /api/admin/media',
    file: 'media.ts',
    method: 'GET',
    build: () => ({ path: '/api/admin/media', init: GET_INIT }),
    expect: ambassadorFloor(200),
  },
  {
    name: 'POST /api/admin/media',
    file: 'media.ts',
    method: 'POST',
    build: () => ({ path: '/api/admin/media', init: upload() }),
    expect: ambassadorFloor(201),
  },
  {
    name: 'PATCH /api/admin/media/:id',
    file: 'media/[id].ts',
    method: 'PATCH',
    build: (fx) => ({
      path: `/api/admin/media/${fx.media.id}`,
      init: send('PATCH', { credit: 'Texarkana Gazette' }),
    }),
    expect: ambassadorFloor(200),
  },
  {
    name: 'POST /api/admin/import-legacy',
    file: 'import-legacy.ts',
    method: 'POST',
    build: () => ({ path: '/api/admin/import-legacy', init: { method: 'POST' } }),
    /*
     * 409, not 200: the fixtures seed a POI, and the importer refuses to run
     * against a populated database without `?force=1`. That refusal is the
     * first thing the handler does after the guard, it needs no network, and it
     * is therefore the cleanest available proof that an admin got through —
     * the alternative, letting it reach `fetch`, would be a blocked outbound
     * call and a 500 that says nothing about authorisation.
     */
    expect: importGuarded(409),
  },
  {
    name: 'POST /api/admin/import-media',
    file: 'import-media.ts',
    method: 'POST',
    build: () => ({ path: '/api/admin/import-media', init: { method: 'POST' } }),
    /*
     * 500, because this one has no early exit: the first thing past the guard
     * is a fetch of the legacy site, `test/setup.ts` refuses it, and the
     * handler's own try/catch turns that into `Media import failed`. Reaching
     * that message is the proof — it is unreachable from the wrong side of the
     * guard, which answers 401 and returns.
     */
    expect: importGuarded(500),
  },
  {
    name: 'GET /api/admin/config-check',
    file: 'config-check.ts',
    method: 'GET',
    build: () => ({ path: '/api/admin/config-check', init: GET_INIT }),
    expect: middlewareThenImportGuard(200),
  },
];

/** Seeds one row of everything the `[id]` routes address. */
export async function seedFixtures(): Promise<Fixtures> {
  const zone = await seedZone(env.DB);
  return {
    poi: await seedPoi(env.DB, { zoneId: zone.id }),
    post: await seedPost(env.DB),
    meetup: await seedMeetup(env.DB, { zoneId: zone.id }),
    media: await seedMedia(env.DB, { zoneId: zone.id }),
  };
}

/* --------------------------------------------------------------- snapshots */

/**
 * The tables a refused request must leave untouched.
 *
 * `users` and `sessions` are deliberately absent: signing the caller in is what
 * the test itself just did, and the middleware slides a live session forward
 * under `waitUntil` on every request that carries one.
 */
const CONTENT_TABLES = [
  'zones',
  'pois',
  'poi_media',
  'posts',
  'post_tags',
  'meetups',
  'media',
  'audit_log',
] as const;

/**
 * Everything the admin surface can write, as one comparable string.
 *
 * Taken either side of a refused request. A route that answers 403 *after*
 * deleting the row passes every status assertion ever written and is the single
 * worst failure this surface can have, so it is checked directly rather than
 * inferred.
 */
export async function contentSnapshot(): Promise<string> {
  const parts: string[] = [];
  for (const table of CONTENT_TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    parts.push(`${table}:${JSON.stringify(results)}`);
  }
  return parts.join('\n');
}
