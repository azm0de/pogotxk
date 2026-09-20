/**
 * PATCH /api/flares/:id — { action: 'rsvp' }.
 *
 * Three stored states and a fourth word that is not a state. `out` deletes the
 * row rather than storing anything, which is the one thing about this endpoint
 * a reader has to be told: the schema's CHECK only allows coming/here/done, so
 * "I am not coming after all" has nowhere to live except absence.
 *
 * The 410s matter more than they look. The client uses 410-not-404 to decide
 * whether to drop the card silently or show an error toast, so a regression to
 * 404 here is a visible bug on every board that has a flare lapse under it.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { FlareRsvpState } from '~/lib/db/flares';
import { asUser, seedFlare, seedRsvp, seedUser, type SeededUser } from '../helpers/factories';

interface PatchBody {
  flare?: { id: number; rsvps: Record<FlareRsvpState, number> };
  mine?: FlareRsvpState | null;
  error?: string;
}

async function rsvp(
  user: SeededUser | null,
  id: number,
  state: string,
): Promise<{ status: number; body: PatchBody }> {
  const url = `https://pogotxk.test/api/flares/${id}`;
  const init: RequestInit = {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'rsvp', state }),
  };
  const request = user ? await asUser(env.DB, user, url, init) : new Request(url, init);
  const res = await SELF.fetch(request);
  return { status: res.status, body: (await res.json()) as PatchBody };
}

function storedState(flareId: number, userId: number): Promise<{ state: string } | null> {
  return env.DB.prepare('SELECT state FROM flare_rsvps WHERE flare_id = ?1 AND user_id = ?2')
    .bind(flareId, userId)
    .first<{ state: string }>();
}

describe('the three stored states', () => {
  it.each(['coming', 'here', 'done'] as const)('%s is recorded and echoed back', async (state) => {
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB);

    const { status, body } = await rsvp(member, flare.id, state);

    expect(status).toBe(200);
    expect(body.mine).toBe(state);
    expect((await storedState(flare.id, member.id))?.state).toBe(state);
    // The counts come back on the same response so the card can re-render
    // without a second round trip.
    expect(body.flare?.rsvps[state]).toBe(1);
  });

  it('moving between states does not stack up rows', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB);

    await rsvp(member, flare.id, 'coming');
    const { body } = await rsvp(member, flare.id, 'here');

    expect(body.flare?.rsvps).toEqual({ coming: 0, here: 1, done: 0 });
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM flare_rsvps WHERE flare_id = ?1',
    )
      .bind(flare.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('counts several trainers separately', async () => {
    const flare = await seedFlare(env.DB);
    const a = await seedUser(env.DB, { role: 'member' });
    const b = await seedUser(env.DB, { role: 'member' });
    const c = await seedUser(env.DB, { role: 'member' });

    await rsvp(a, flare.id, 'coming');
    await rsvp(b, flare.id, 'coming');
    const { body } = await rsvp(c, flare.id, 'here');

    expect(body.flare?.rsvps).toEqual({ coming: 2, here: 1, done: 0 });
  });

  it('an rsvp is not limited to the flare you raised', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const joiner = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { createdBy: author.id });

    expect((await rsvp(joiner, flare.id, 'coming')).status).toBe(200);
  });
});

describe("out is not a state — it deletes the row", () => {
  it('removes an existing rsvp and reports no state', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB);
    await seedRsvp(env.DB, flare, member, 'coming');

    const { status, body } = await rsvp(member, flare.id, 'out');

    expect(status).toBe(200);
    expect(body.mine).toBeNull();
    expect(await storedState(flare.id, member.id)).toBeNull();
    expect(body.flare?.rsvps).toEqual({ coming: 0, here: 0, done: 0 });
  });

  it('is a no-op when there was nothing to remove', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB);

    const { status, body } = await rsvp(member, flare.id, 'out');

    expect(status).toBe(200);
    expect(body.mine).toBeNull();
  });

  it('takes only the caller off, not everyone', async () => {
    const flare = await seedFlare(env.DB);
    const leaving = await seedUser(env.DB, { role: 'member' });
    const staying = await seedUser(env.DB, { role: 'member' });
    await seedRsvp(env.DB, flare, leaving, 'coming');
    await seedRsvp(env.DB, flare, staying, 'coming');

    const { body } = await rsvp(leaving, flare.id, 'out');

    expect(body.flare?.rsvps.coming).toBe(1);
    expect((await storedState(flare.id, staying.id))?.state).toBe('coming');
  });

  it('is never written to the table, whatever a client sends', async () => {
    // The schema's CHECK would reject it, so this is really a guard on the
    // route branching before the INSERT rather than relying on the database to
    // say no — a 500 and a 200 look very different to the board.
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB);

    await rsvp(member, flare.id, 'out');

    const any = await env.DB.prepare("SELECT COUNT(*) AS n FROM flare_rsvps WHERE state = 'out'")
      .first<{ n: number }>();
    expect(any?.n).toBe(0);
  });
});

describe('a flare that is over answers 410, not 404', () => {
  it('closed by hand', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { closed: true });

    const { status } = await rsvp(member, flare.id, 'coming');

    expect(status).toBe(410);
    expect(await storedState(flare.id, member.id)).toBeNull();
  });

  it('lapsed on its own', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { expired: true });

    expect((await rsvp(member, flare.id, 'coming')).status).toBe(410);
  });

  it('out is refused on a dead flare too, rather than quietly succeeding', async () => {
    // The guard is before the branch, so leaving a flare that already ended is
    // 410 as well. That is the honest answer: the card is gone either way.
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { expired: true });
    await seedRsvp(env.DB, flare, member, 'coming');

    expect((await rsvp(member, flare.id, 'out')).status).toBe(410);
  });

  it('a flare that never existed is still 404 — the distinction is the point', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    expect((await rsvp(member, 4242, 'coming')).status).toBe(404);
  });

  it('a flare expiring exactly now is over', async () => {
    // `expires_at <= now` rather than `<`. A flare whose last second is this
    // second is not worth joining.
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { expiresAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });

    expect((await rsvp(member, flare.id, 'coming')).status).toBe(410);
  });
});

describe('who may rsvp', () => {
  it('anonymous is refused', async () => {
    const flare = await seedFlare(env.DB);
    expect((await rsvp(null, flare.id, 'coming')).status).toBe(401);
  });

  it('a guest is refused', async () => {
    const guest = await seedUser(env.DB, { role: 'guest' });
    const flare = await seedFlare(env.DB);
    expect((await rsvp(guest, flare.id, 'coming')).status).toBe(403);
  });

  it.each(['member', 'ambassador', 'admin'] as const)('a %s may', async (role) => {
    const user = await seedUser(env.DB, { role });
    const flare = await seedFlare(env.DB);
    expect((await rsvp(user, flare.id, 'coming')).status).toBe(200);
  });
});

describe('malformed requests', () => {
  it('an unknown state is refused', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB);
    expect((await rsvp(member, flare.id, 'maybe')).status).toBe(422);
  });

  it('an unknown action is refused', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB);
    const res = await SELF.fetch(
      await asUser(env.DB, member, `https://pogotxk.test/api/flares/${flare.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delete' }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it.each(['0', '-1', 'abc'])('the id %s is rejected before anything is read', async (id) => {
    const member = await seedUser(env.DB, { role: 'member' });
    const res = await SELF.fetch(
      await asUser(env.DB, member, `https://pogotxk.test/api/flares/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rsvp', state: 'coming' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('a body that is not JSON is refused', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB);
    const res = await SELF.fetch(
      await asUser(env.DB, member, `https://pogotxk.test/api/flares/${flare.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('the board reports the viewer their own answer', () => {
  it('mine carries the caller rsvp and nobody else', async () => {
    const mine = await seedUser(env.DB, { role: 'member' });
    const theirs = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB);

    await rsvp(mine, flare.id, 'here');
    await rsvp(theirs, flare.id, 'done');

    const res = await SELF.fetch(
      await asUser(env.DB, mine, 'https://pogotxk.test/api/flares'),
    );
    const board = (await res.json()) as { mine: Record<string, FlareRsvpState> };

    expect(board.mine).toEqual({ [flare.id]: 'here' });
  });

  it('an anonymous board carries no answers at all', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB);
    await rsvp(member, flare.id, 'coming');

    const res = await SELF.fetch('https://pogotxk.test/api/flares');
    const board = (await res.json()) as { mine: Record<string, FlareRsvpState> };

    expect(board.mine).toEqual({});
  });

  it('an answer on a flare that has ended drops out of mine', async () => {
    const member = await seedUser(env.DB, { role: 'member' });
    const live = await seedFlare(env.DB, { kind: 'raid' });
    const over = await seedFlare(env.DB, { kind: 'trade', expired: true });
    await seedRsvp(env.DB, live, member, 'coming');
    await seedRsvp(env.DB, over, member, 'coming');

    const res = await SELF.fetch(await asUser(env.DB, member, 'https://pogotxk.test/api/flares'));
    const board = (await res.json()) as { mine: Record<string, FlareRsvpState> };

    expect(board.mine).toEqual({ [live.id]: 'coming' });
  });
});
