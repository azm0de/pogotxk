/**
 * POST /api/flares — raising one.
 *
 * The three things worth pinning here are the ones a reader of the route cannot
 * check by inspection: that every kind's TTL lands on a real `expires_at`, that
 * the per-kind field rules are applied *silently* rather than as a rejection,
 * and that the duplicate guard keys on the same triple the SQL says it does.
 *
 * The silent nulling is deliberate, and it is half of an asymmetry — PATCH
 * {action:'edit'} answers 422 for the same field on the same kind. The other
 * half, and the reasoning, are in edit.test.ts.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { FLARE_KINDS, FLARE_TTL_MINUTES, type FlareKind } from '~/lib/db/flares';
import { asUser, seedFlare, seedPoi, seedUser, seedZone, type SeededUser } from '../helpers/factories';

const FLARES = 'https://pogotxk.test/api/flares';

interface PostBody {
  flare?: {
    id: number;
    kind: FlareKind;
    boss: string | null;
    tier: string | null;
    needed: number | null;
    expiresAt: string;
  };
  error?: string;
}

async function post(
  user: SeededUser | null,
  body: unknown,
): Promise<{ status: number; body: PostBody }> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  const request = user ? await asUser(env.DB, user, FLARES, init) : new Request(FLARES, init);
  const res = await SELF.fetch(request);
  return { status: res.status, body: (await res.json()) as PostBody };
}

/** The stored row, which is where the silent nulling is actually visible. */
function row(id: number): Promise<Record<string, unknown> | null> {
  return env.DB.prepare('SELECT * FROM flares WHERE id = ?1')
    .bind(id)
    .first<Record<string, unknown>>();
}

describe('who may raise a flare', () => {
  it('anonymous is refused', async () => {
    expect((await post(null, { kind: 'raid' })).status).toBe(401);
  });

  it('a guest is refused', async () => {
    const guest = await seedUser(env.DB, { role: 'guest' });
    expect((await post(guest, { kind: 'raid' })).status).toBe(403);
  });

  it.each(['member', 'ambassador', 'admin'] as const)('a %s may', async (role) => {
    const user = await seedUser(env.DB, { role });
    const { status, body } = await post(user, { kind: 'raid' });
    expect(status).toBe(201);
    expect(body.flare?.id).toBeGreaterThan(0);
  });

  it('a banned member is refused — their session resolves to nobody', async () => {
    const banned = await seedUser(env.DB, { role: 'member', isBanned: true });
    expect((await post(banned, { kind: 'raid' })).status).toBe(401);
  });
});

describe('every kind can be raised, and carries its own lifetime', () => {
  it.each(FLARE_KINDS)('%s', async (kind) => {
    const member = await seedUser(env.DB, { role: 'member' });
    const { status, body } = await post(member, { kind });

    expect(status).toBe(201);
    expect(body.flare?.kind).toBe(kind);

    // Compared as a duration, not a timestamp: the route stamps `expires_at`
    // from its own clock, so the gap is the only stable fact.
    const minutes = (Date.parse(body.flare!.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(FLARE_TTL_MINUTES[kind] - 1);
    expect(minutes).toBeLessThanOrEqual(FLARE_TTL_MINUTES[kind]);
  });

  it('the six defaults are six numbers, not one reused', async () => {
    // Guards the mapping itself: a regression that pointed every kind at
    // FLARE_TTL_MINUTES.raid would still pass each case above on its own.
    expect(Object.values(FLARE_TTL_MINUTES)).toEqual([45, 30, 120, 20, 120, 60]);
  });
});

describe('the minutes override', () => {
  it('replaces the per-kind default', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const { status, body } = await post(member, { kind: 'raid', minutes: 90 });

    expect(status).toBe(201);
    const minutes = (Date.parse(body.flare!.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(89);
    expect(minutes).toBeLessThanOrEqual(90);
  });

  it.each([5, 240])('accepts the boundary %i', async (minutes) => {
    const member = await seedUser(env.DB, { role: 'member' });
    expect((await post(member, { kind: 'trade', minutes })).status).toBe(201);
  });

  it.each([4, 241, 0, -30])('rejects %i', async (minutes) => {
    const member = await seedUser(env.DB, { role: 'member' });
    expect((await post(member, { kind: 'trade', minutes })).status).toBe(422);
  });

  it('rejects a fractional override rather than rounding it', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    expect((await post(member, { kind: 'trade', minutes: 42.5 })).status).toBe(422);
  });
});

describe('per-kind fields are silently dropped, not rejected', () => {
  /*
   * Asserting the 201 is the point. A future tidy-up that turned this into a
   * 422 would break the /go screen, which posts boss and tier from one form
   * whatever kind the trainer picked — the route dropping what does not apply
   * is what lets that form stay one form.
   */
  it.each([
    ['raid', { boss: 'Mewtwo', tier: '5', needed: 4 }, { boss: 'Mewtwo', tier: '5', needed: null }],
    [
      'remote_invites',
      { boss: 'Mewtwo', tier: '5', needed: 4 },
      { boss: 'Mewtwo', tier: null, needed: 4 },
    ],
    ['gym_takedown', { boss: 'Mewtwo', tier: '5', needed: 4 }, { boss: null, tier: null, needed: null }],
    ['meetup_here', { boss: 'Mewtwo', tier: '5', needed: 4 }, { boss: null, tier: null, needed: null }],
    ['trade', { boss: 'Mewtwo', tier: '5', needed: 4 }, { boss: null, tier: null, needed: null }],
    ['help', { boss: 'Mewtwo', tier: '5', needed: 4 }, { boss: null, tier: null, needed: null }],
  ] as const)('%s keeps only what it carries', async (kind, sent, kept) => {
    const member = await seedUser(env.DB, { role: 'member' });
    const { status, body } = await post(member, { kind, ...sent });

    expect(status).toBe(201);
    expect(body.flare?.boss).toBe(kept.boss);
    expect(body.flare?.tier).toBe(kept.tier);
    expect(body.flare?.needed).toBe(kept.needed);

    const stored = await row(body.flare!.id);
    expect(stored?.boss).toBe(kept.boss);
    expect(stored?.tier).toBe(kept.tier);
    expect(stored?.needed).toBe(kept.needed);
  });

  it('the note survives on every kind', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const { body } = await post(member, { kind: 'help', note: '  need a hand  ' });
    expect((await row(body.flare!.id))?.note).toBe('need a hand');
  });

  it.each(['boss', 'tier', 'note'] as const)(
    'a %s of nothing but spaces is stored as NULL, not as an empty string',
    async (field) => {
      /*
       * zod trims, so "   " reaches the route as "", and an empty string is not
       * nullish — it used to be stored verbatim, leaving two spellings of "no
       * boss" in one column for anything that later asks `IS NULL`. PATCH
       * {action:'edit'} has always normalised; this is the same rule on the way
       * in. Both clients happen to trim before posting, which is why nothing
       * looked wrong from the site.
       */
      const member = await seedUser(env.DB, { role: 'member' });
      const { status, body } = await post(member, { kind: 'raid', [field]: '   ' });

      expect(status).toBe(201);
      expect((await row(body.flare!.id))?.[field]).toBeNull();
    },
  );

  it.each(['boss', 'tier', 'note'] as const)('an explicit empty %s is NULL too', async (field) => {
    const member = await seedUser(env.DB, { role: 'member' });
    const { body } = await post(member, { kind: 'raid', [field]: '' });
    expect((await row(body.flare!.id))?.[field]).toBeNull();
  });

  it('the two ways of raising the same blank flare agree with each other', async () => {
    // The point of the rule: a flare created blank and a flare edited blank are
    // the same row, not two different spellings of it.
    const member = await seedUser(env.DB, { role: 'member' });
    const { body } = await post(member, { kind: 'raid', boss: '' });

    const edited = await seedUser(env.DB, { role: 'member' });
    const { body: second } = await post(edited, { kind: 'raid', boss: 'Mewtwo' });
    await SELF.fetch(
      await asUser(env.DB, edited, `${FLARES}/${second.flare!.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'edit', boss: '   ' }),
      }),
    ).then((res) => res.json());

    expect((await row(body.flare!.id))?.boss).toBe((await row(second.flare!.id))?.boss);
  });

  it('a note over the limit is refused rather than truncated', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    expect((await post(member, { kind: 'help', note: 'x'.repeat(281) })).status).toBe(422);
    expect((await post(member, { kind: 'trade', note: 'x'.repeat(280) })).status).toBe(201);
  });

  it('an unknown kind is refused', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    expect((await post(member, { kind: 'party' })).status).toBe(422);
  });

  it('a body that is not JSON is refused', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const res = await SELF.fetch(
      await asUser(env.DB, member, FLARES, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('the location', () => {
  it('a published POI is accepted and pulls its zone across', async () => {
    const zone = await seedZone(env.DB);
    const poi = await seedPoi(env.DB, { zoneId: zone.id });
    const member = await seedUser(env.DB, { role: 'member' });

    const { status, body } = await post(member, { kind: 'raid', poiId: poi.id });

    expect(status).toBe(201);
    const stored = await row(body.flare!.id);
    expect(stored?.poi_id).toBe(poi.id);
    // Denormalised from the POI rather than taken from the client, which is
    // the only reason it is worth asserting.
    expect(stored?.zone_id).toBe(zone.id);
  });

  it.each(['pending', 'rejected', 'archived'] as const)(
    'a %s POI is refused with 422, and nothing is written',
    async (status) => {
      const poi = await seedPoi(env.DB, { status });
      const member = await seedUser(env.DB, { role: 'member' });

      expect((await post(member, { kind: 'raid', poiId: poi.id })).status).toBe(422);
      expect(
        await env.DB.prepare('SELECT COUNT(*) AS n FROM flares').first<{ n: number }>(),
      ).toEqual({ n: 0 });
    },
  );

  it('a POI that does not exist is refused with 422', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    expect((await post(member, { kind: 'raid', poiId: 9999 })).status).toBe(422);
  });

  it('no POI at all is fine — a flare need not have a location', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const { status, body } = await post(member, { kind: 'trade', poiId: null });
    expect(status).toBe(201);
    expect((await row(body.flare!.id))?.poi_id).toBeNull();
  });
});

describe('the duplicate guard', () => {
  it('the same kind at the same place by the same trainer is 409', async () => {
    const poi = await seedPoi(env.DB);
    const member = await seedUser(env.DB, { role: 'member' });

    expect((await post(member, { kind: 'raid', poiId: poi.id })).status).toBe(201);
    expect((await post(member, { kind: 'raid', poiId: poi.id })).status).toBe(409);
  });

  it('two location-less flares of one kind collide too', async () => {
    // The `poi_id IS ?3` in hasDuplicateFlare: SQLite's IS compares NULLs as
    // equal, which is the whole reason that operator is there rather than `=`.
    const member = await seedUser(env.DB, { role: 'member' });
    expect((await post(member, { kind: 'help' })).status).toBe(201);
    expect((await post(member, { kind: 'help' })).status).toBe(409);
  });

  it('a different kind at the same place does not collide', async () => {
    const poi = await seedPoi(env.DB);
    const member = await seedUser(env.DB, { role: 'member' });
    expect((await post(member, { kind: 'raid', poiId: poi.id })).status).toBe(201);
    expect((await post(member, { kind: 'trade', poiId: poi.id })).status).toBe(201);
  });

  it('the same kind at a different place does not collide', async () => {
    const a = await seedPoi(env.DB);
    const b = await seedPoi(env.DB);
    const member = await seedUser(env.DB, { role: 'member' });
    expect((await post(member, { kind: 'raid', poiId: a.id })).status).toBe(201);
    expect((await post(member, { kind: 'raid', poiId: b.id })).status).toBe(201);
  });

  it('another trainer raising the same thing is not a duplicate', async () => {
    const poi = await seedPoi(env.DB);
    const one = await seedUser(env.DB, { role: 'member' });
    const two = await seedUser(env.DB, { role: 'member' });
    expect((await post(one, { kind: 'raid', poiId: poi.id })).status).toBe(201);
    expect((await post(two, { kind: 'raid', poiId: poi.id })).status).toBe(201);
  });

  it('a closed flare does not block a new one', async () => {
    const poi = await seedPoi(env.DB);
    const member = await seedUser(env.DB, { role: 'member' });
    await seedFlare(env.DB, { kind: 'raid', poiId: poi.id, createdBy: member.id, closed: true });
    expect((await post(member, { kind: 'raid', poiId: poi.id })).status).toBe(201);
  });

  it('an expired flare does not block a new one', async () => {
    const poi = await seedPoi(env.DB);
    const member = await seedUser(env.DB, { role: 'member' });
    await seedFlare(env.DB, { kind: 'raid', poiId: poi.id, createdBy: member.id, expired: true });
    expect((await post(member, { kind: 'raid', poiId: poi.id })).status).toBe(201);
  });
});

describe('the response and the board agree', () => {
  it('a new flare is on GET /api/flares at once, attributed to its author', async () => {
    const member = await seedUser(env.DB, { role: 'member', trainerName: 'azm.0' });
    const { body } = await post(member, { kind: 'raid', boss: 'Mewtwo' });

    const res = await SELF.fetch(FLARES);
    const board = (await res.json()) as {
      flares: { id: number; author: { id: number; name: string; team: string | null } | null }[];
    };

    expect(board.flares).toHaveLength(1);
    expect(board.flares[0]!.id).toBe(body.flare!.id);
    expect(board.flares[0]!.author).toEqual({ id: member.id, name: 'azm.0', team: null });
  });

  it('the board never caches', async () => {
    const res = await SELF.fetch(FLARES);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
