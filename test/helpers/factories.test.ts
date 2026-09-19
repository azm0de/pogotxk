/**
 * Tests for the factories, because four other test suites are built on them.
 *
 * The load-bearing one is "a seeded session authenticates": everything else in
 * the harness assumes a token from `seedSession` is indistinguishable from one
 * the OAuth callback minted, and the only honest way to show that is to send it
 * through the real middleware on a real route. `/api/me.json` is the cheapest
 * route that answers with the resolved user and nothing else.
 *
 * It doubles as the worked example of the module. If you are about to write a
 * suite on top of `factories.ts`, read this file first.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getSessionUser, touchSession } from '~/lib/auth/session';
import { ROLES } from '~/lib/auth/types';
import { FLARE_KINDS } from '~/lib/db/flares';
import { LIVE_BOARD_NAME, liveNamespace } from '~/do/LiveBoard';
import {
  asToken,
  asUser,
  authCookie,
  iso,
  isoIn,
  jsonAsToken,
  jsonAsUser,
  jsonRequest,
  seedFlare,
  seedPoi,
  seedRsvp,
  seedSession,
  seedUser,
  seedZone,
  sessionIdFor,
} from './factories';

const ME = 'https://pogotxk.test/api/me.json';

interface MeResponse {
  user: { id: number; username: string; role: string; displayName: string } | null;
}

async function me(request: Request): Promise<MeResponse> {
  const res = await SELF.fetch(request);
  expect(res.status).toBe(200);
  return (await res.json()) as MeResponse;
}

describe('sessions authenticate against a real route', () => {
  it('a seeded token signs in as the seeded user', async () => {
    const user = await seedUser(env.DB, { username: 'ashk', role: 'ambassador' });
    const token = await seedSession(env.DB, user);

    const body = await me(asToken(token, ME));

    expect(body.user).not.toBeNull();
    expect(body.user?.id).toBe(user.id);
    expect(body.user?.username).toBe('ashk');
    expect(body.user?.role).toBe('ambassador');
  });

  it('asUser mints the session and signs the request in one call', async () => {
    const user = await seedUser(env.DB, { username: 'misty' });

    const body = await me(await asUser(env.DB, user, ME));

    expect(body.user?.id).toBe(user.id);
  });

  it('no cookie means no user', async () => {
    const body = await me(new Request(ME));
    expect(body.user).toBeNull();
  });

  it('the cookie carries the token and the table stores its hash', async () => {
    // The scheme the whole harness rests on. If this ever inverts, every other
    // suite is testing a login that production would reject.
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user);

    expect(authCookie(token)).toBe(`pogotxk_session=${token}`);

    const stored = await env.DB.prepare('SELECT id FROM sessions WHERE user_id = ?1')
      .bind(user.id)
      .first<{ id: string }>();

    expect(stored?.id).toBe(await sessionIdFor(token));
    expect(stored?.id).not.toBe(token);
  });

  it('honours an expiry override', async () => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user, { expiresAt: isoIn(-60) });

    expect(await getSessionUser(env.DB, token)).toBeUndefined();
    expect((await me(asToken(token, ME))).user).toBeNull();
  });

  it('an aged session slides forward on use, a fresh one does not', async () => {
    // `touchSession` writes only once a session has aged by a day, so the two
    // cases differ by how far `expires_at` has drifted from the fortnight.
    const user = await seedUser(env.DB);
    const fortnight = 14 * 86_400;

    const fresh = await seedSession(env.DB, user);
    const freshBefore = await expiryOf(fresh);
    await touchSession(env.DB, fresh);
    expect(await expiryOf(fresh)).toBe(freshBefore);

    const aged = await seedSession(env.DB, user, {
      expiresAt: isoIn(fortnight - 2 * 86_400),
      createdAt: iso(Date.now() - 2 * 86_400_000),
    });
    const agedBefore = await expiryOf(aged);
    await touchSession(env.DB, aged);
    expect(await expiryOf(aged) > agedBefore).toBe(true);
  });

  async function expiryOf(token: string): Promise<string> {
    const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE id = ?1')
      .bind(await sessionIdFor(token))
      .first<{ expires_at: string }>();
    if (!row) throw new Error('session row vanished');
    return row.expires_at;
  }
});

/**
 * Astro's CSRF check is the tax on every write in this suite, and the first
 * test is the one that says why: forget the header and the answer is a 403
 * whose body is not JSON, so `res.json()` throws and the real status never
 * reaches an assertion. `/api/admin/posts` is the cheapest route that
 * distinguishes all three outcomes — refused by Astro, refused by the
 * middleware, or actually written.
 */
describe('write requests carry what Astro insists on', () => {
  const POSTS = 'https://pogotxk.test/api/admin/posts';

  it('a hand-built POST never reaches the route', async () => {
    const res = await SELF.fetch(new Request(POSTS, { method: 'POST' }));

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).not.toContain('application/json');
  });

  it('jsonRequest gets past it, and the app answers for itself', async () => {
    const res = await SELF.fetch(jsonRequest(POSTS, { json: { title: 'x' } }));

    // The middleware's refusal, in JSON — which is proof the request got in.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('jsonAsUser signs it in too, so a real write is one call', async () => {
    const amb = await seedUser(env.DB, { role: 'ambassador' });

    const res = await SELF.fetch(
      await jsonAsUser(env.DB, amb, POSTS, { json: { title: 'Gym rotation' } }),
    );

    expect(res.status).toBe(201);
    // Read the row back rather than the response: it is the only thing that
    // shows the body was serialised, typed and parsed the whole way through.
    const { id } = (await res.json()) as { id: number };
    const row = await env.DB.prepare('SELECT title FROM posts WHERE id = ?1')
      .bind(id)
      .first<{ title: string }>();
    expect(row?.title).toBe('Gym rotation');
  });

  it('jsonAsToken is the form for a token already in hand', async () => {
    const amb = await seedUser(env.DB, { role: 'ambassador' });
    const token = await seedSession(env.DB, amb);

    const res = await SELF.fetch(jsonAsToken(token, POSTS, { json: { title: 'Second' } }));

    expect(res.status).toBe(201);
  });

  it('leaves an explicit method and body alone', async () => {
    // The escape hatch. A body that is not valid JSON is a thing routes have to
    // be tested against, and `json` cannot express one.
    const request = jsonRequest(POSTS, { method: 'PATCH', body: 'not json' });

    expect(request.method).toBe('PATCH');
    expect(request.headers.get('origin')).toBe('https://pogotxk.test');
    // Left as whatever the platform infers, and in particular not relabelled
    // as JSON — a body handed over verbatim is not the helper's to describe.
    // `readJson` parses the bytes regardless of the type, so this still lands
    // on "Body must be valid JSON", which is the case such a test wants.
    expect(request.headers.get('content-type')).not.toContain('application/json');
    expect(await request.text()).toBe('not json');
  });
});

describe('seedUser', () => {
  it.each(ROLES)('creates a %s', async (role) => {
    const user = await seedUser(env.DB, { role });
    expect(user.role).toBe(role);
    expect((await me(await asUser(env.DB, user, ME))).user?.role).toBe(role);
  });

  it('creates a banned user, whose session resolves to nobody', async () => {
    const user = await seedUser(env.DB, { isBanned: true, banReason: 'spam' });

    expect(user.is_banned).toBe(1);
    expect(user.ban_reason).toBe('spam');
    expect((await me(await asUser(env.DB, user, ME))).user).toBeNull();
  });

  it('keeps discord_id unique without being told', async () => {
    const a = await seedUser(env.DB);
    const b = await seedUser(env.DB);
    expect(a.discord_id).not.toBe(b.discord_id);
  });

  it('carries the optional profile through', async () => {
    const user = await seedUser(env.DB, {
      team: 'mystic',
      trainerName: 'Blue',
      trainerLevel: 50,
      globalName: 'Blue Oak',
    });

    expect(user.team).toBe('mystic');
    expect(user.trainer_level).toBe(50);
    expect((await me(await asUser(env.DB, user, ME))).user?.displayName).toBe('Blue Oak');
  });
});

describe('seedZone and seedPoi', () => {
  it('a zone is the default zone unless told otherwise, and only one is', async () => {
    const first = await seedZone(env.DB);
    const second = await seedZone(env.DB);

    expect(second.is_default).toBe(1);
    const reread = await env.DB.prepare('SELECT is_default FROM zones WHERE id = ?1')
      .bind(first.id)
      .first<{ is_default: number }>();
    expect(reread?.is_default).toBe(0);
  });

  it('a POI lands in the default zone when none is named', async () => {
    const zone = await seedZone(env.DB);
    const poi = await seedPoi(env.DB);
    expect(poi.zone_id).toBe(zone.id);
    expect(poi.status).toBe('published');
  });

  it('creates an unpublished POI, which the flare API refuses', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const poi = await seedPoi(env.DB, { status: 'pending' });
    expect(poi.status).toBe('pending');

    const res = await SELF.fetch(
      await asUser(env.DB, member, 'https://pogotxk.test/api/flares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'raid', poiId: poi.id }),
      }),
    );

    expect(res.status).toBe(422);
  });
});

describe('seedFlare and seedRsvp', () => {
  it.each(FLARE_KINDS)('creates a %s flare', async (kind) => {
    const flare = await seedFlare(env.DB, { kind });
    expect(flare.kind).toBe(kind);
    // Every kind gets the app's own lifetime, so a seeded flare is live.
    expect(flare.expires_at > iso()).toBe(true);
    expect(flare.closed_at).toBeNull();
  });

  it('creates expired, closed and Discord-tracked flares', async () => {
    const expired = await seedFlare(env.DB, { expired: true });
    expect(expired.expires_at < iso()).toBe(true);

    const closed = await seedFlare(env.DB, { closed: true });
    expect(closed.closed_at).not.toBeNull();

    const owing = await seedFlare(env.DB, { discordMessageId: 'msg-1' });
    expect(owing.discord_message_id).toBe('msg-1');
    expect(owing.discord_closed_at).toBeNull();

    const settled = await seedFlare(env.DB, {
      discordMessageId: 'msg-2',
      discordClosedAt: iso(),
    });
    expect(settled.discord_closed_at).not.toBeNull();
  });

  it('attributes a flare to its author and its POI', async () => {
    const author = await seedUser(env.DB);
    const zone = await seedZone(env.DB);
    const poi = await seedPoi(env.DB, { zoneId: zone.id });

    const flare = await seedFlare(env.DB, {
      createdBy: author.id,
      poiId: poi.id,
      zoneId: zone.id,
      kind: 'remote_invites',
      boss: 'Mewtwo',
      needed: 3,
    });

    expect(flare.created_by).toBe(author.id);
    expect(flare.poi_id).toBe(poi.id);
    expect(flare.needed).toBe(3);
  });

  it.each(['coming', 'here', 'done'] as const)('records a %s rsvp', async (state) => {
    const flare = await seedFlare(env.DB);
    const user = await seedUser(env.DB);

    const rsvp = await seedRsvp(env.DB, flare, user, state);

    expect(rsvp.state).toBe(state);
    expect(rsvp.flare_id).toBe(flare.id);
    expect(rsvp.user_id).toBe(user.id);
  });

  it('re-rsvping the same user moves them rather than failing', async () => {
    const flare = await seedFlare(env.DB);
    const user = await seedUser(env.DB);

    await seedRsvp(env.DB, flare, user, 'coming');
    expect((await seedRsvp(env.DB, flare, user, 'here')).state).toBe('here');
  });
});

describe('bindings the suites depend on', () => {
  it('the LIVE Durable Object binding resolves to the LiveBoard class', async () => {
    // This is what the `main` entry in vitest.config.ts buys: a binding naming a
    // class the script does not export fails here, loudly, rather than in a
    // suite that only notices its broadcasts went nowhere.
    const ns = liveNamespace();
    expect(ns).not.toBeNull();

    const published = await ns!.getByName(LIVE_BOARD_NAME).publish({
      type: 'presence',
      connections: 0,
    });
    expect(published).toBe(0);
  });

  it('each test starts from an empty database, KV and R2', async () => {
    // Not a given — the pool no longer rolls storage back on its own. See the
    // comment at the top of test/setup.ts before relying on this.
    const users = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{
      count: number;
    }>();
    expect(users?.count).toBe(0);
    expect((await env.CACHE.list()).keys).toEqual([]);
    expect((await env.MEDIA.list()).objects).toEqual([]);

    // The schema survives the emptying, which is the other half of the deal.
    const migrated = await env.DB.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{
      count: number;
    }>();
    expect(migrated?.count).toBe(4);
  });
});
