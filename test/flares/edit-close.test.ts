/**
 * PATCH /api/flares/:id — { action: 'edit' } and { action: 'close' }.
 *
 * Two behaviours here look like bugs from a distance and are not:
 *
 *  1. Edit answers 422 for a field the kind does not carry, where POST silently
 *     nulls the same field on the same kind. They are different situations. On
 *     POST the fields arrive from one form that offers boss and tier whatever
 *     kind is picked, so dropping what does not apply is the only way that form
 *     works. An edit names one field on purpose; silently dropping it would
 *     report success for a correction that never happened. There is a paired
 *     test below that states both halves in one place.
 *
 *  2. Close has no 410 check, where rsvp and edit both have one. Working out
 *     why is the exercise: closing is the action that settles the flare's
 *     Discord embed, and an expired flare's embed is exactly the one still
 *     advertising a raid that is over. A 410 would block the one request that
 *     tidies it up, and would turn a double-tap on Close into an error toast.
 *     Tested below as "closing a flare that has already ended".
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  FLARE_KINDS,
  flareCarriesBoss,
  flareCarriesTier,
  mayAlterFlare,
  type FlareKind,
} from '~/lib/db/flares';
import type { Role } from '~/lib/auth/types';
import { asUser, iso, seedFlare, seedUser, type SeededUser } from '../helpers/factories';

interface Body {
  flare?: { id: number; boss: string | null; tier: string | null };
  id?: number;
  closed?: boolean;
  error?: string;
}

async function patch(
  user: SeededUser | null,
  id: number,
  payload: unknown,
): Promise<{ status: number; body: Body }> {
  const url = `https://pogotxk.test/api/flares/${id}`;
  const init: RequestInit = {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
  const request = user ? await asUser(env.DB, user, url, init) : new Request(url, init);
  const res = await SELF.fetch(request);
  return { status: res.status, body: (await res.json()) as Body };
}

function stored(id: number): Promise<{ boss: string | null; tier: string | null; closed_at: string | null } | null> {
  return env.DB.prepare('SELECT boss, tier, closed_at FROM flares WHERE id = ?1')
    .bind(id)
    .first<{ boss: string | null; tier: string | null; closed_at: string | null }>();
}

function auditRows(): Promise<{ n: number } | null> {
  return env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'flare'").first<{
    n: number;
  }>();
}

/* --------------------------------------------------------------------- edit */

describe('editing the fields a kind carries', () => {
  it('corrects the boss on a raid', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'raid', boss: 'Mewtoo', createdBy: author.id });

    const { status, body } = await patch(author, flare.id, { action: 'edit', boss: 'Mewtwo' });

    expect(status).toBe(200);
    expect(body.flare?.boss).toBe('Mewtwo');
    expect((await stored(flare.id))?.boss).toBe('Mewtwo');
  });

  it('corrects the tier on a raid', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'raid', tier: '3', createdBy: author.id });

    const { status } = await patch(author, flare.id, { action: 'edit', tier: '5' });

    expect(status).toBe(200);
    expect((await stored(flare.id))?.tier).toBe('5');
  });

  it('corrects the boss on remote invites, which also carry one', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'remote_invites', createdBy: author.id });

    expect((await patch(author, flare.id, { action: 'edit', boss: 'Lugia' })).status).toBe(200);
    expect((await stored(flare.id))?.boss).toBe('Lugia');
  });

  it('changes both at once', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'raid', createdBy: author.id });

    await patch(author, flare.id, { action: 'edit', boss: 'Rayquaza', tier: '5' });

    expect(await stored(flare.id)).toMatchObject({ boss: 'Rayquaza', tier: '5' });
  });

  it('an explicit null clears a field, an absent key leaves it alone', async () => {
    // The distinction the route builds its UPDATE by hand for: COALESCE cannot
    // express "set this to nothing", and removing a boss typed by mistake is
    // half the point of an edit.
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, {
      kind: 'raid',
      boss: 'Mewtwo',
      tier: '5',
      createdBy: author.id,
    });

    await patch(author, flare.id, { action: 'edit', boss: null });

    expect(await stored(flare.id)).toMatchObject({ boss: null, tier: '5' });
  });

  it('an empty string clears a field too', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'raid', boss: 'Mewtwo', createdBy: author.id });

    await patch(author, flare.id, { action: 'edit', boss: '' });

    expect((await stored(flare.id))?.boss).toBeNull();
  });

  it('naming no field at all is refused', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'raid', createdBy: author.id });

    expect((await patch(author, flare.id, { action: 'edit' })).status).toBe(422);
  });

  it('will not change the kind or the location through the back door', async () => {
    // Deliberately outside the schema: changing either is indistinguishable
    // from raising a different flare. Unknown keys are dropped, so the request
    // is refused for naming nothing it *can* change rather than accepted and
    // partially applied.
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'raid', createdBy: author.id });

    const { status } = await patch(author, flare.id, { action: 'edit', kind: 'trade', poiId: 1 });

    expect(status).toBe(422);
    const row = await env.DB.prepare('SELECT kind, poi_id FROM flares WHERE id = ?1')
      .bind(flare.id)
      .first<{ kind: string; poi_id: number | null }>();
    expect(row).toEqual({ kind: 'raid', poi_id: null });
  });
});

describe('editing a field the kind does not carry is refused', () => {
  it.each(['gym_takedown', 'meetup_here', 'trade', 'help'] as const)(
    'boss on a %s is 422',
    async (kind) => {
      const author = await seedUser(env.DB, { role: 'member' });
      const flare = await seedFlare(env.DB, { kind, createdBy: author.id });

      const { status } = await patch(author, flare.id, { action: 'edit', boss: 'Mewtwo' });

      expect(status).toBe(422);
      expect((await stored(flare.id))?.boss).toBeNull();
    },
  );

  it.each(['gym_takedown', 'meetup_here', 'remote_invites', 'trade', 'help'] as const)(
    'tier on a %s is 422',
    async (kind) => {
      const author = await seedUser(env.DB, { role: 'member' });
      const flare = await seedFlare(env.DB, { kind, createdBy: author.id });

      const { status } = await patch(author, flare.id, { action: 'edit', tier: '5' });

      expect(status).toBe(422);
      expect((await stored(flare.id))?.tier).toBeNull();
    },
  );

  it('clearing a field the kind does not carry is refused as well', async () => {
    // `!== undefined`, so an explicit null still names the field. A trade flare
    // has no boss to clear, and pretending otherwise would report a change
    // that never happened.
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'trade', createdBy: author.id });

    expect((await patch(author, flare.id, { action: 'edit', boss: null })).status).toBe(422);
  });
});

describe('one rule, not three copies of it', () => {
  /*
   * `flareCarriesBoss` and `flareCarriesTier` say they are what the API
   * enforces — scripts/test-flare-permissions.ts tests them, and the client
   * renders its form from them. These drive the API from the same functions,
   * so a kind added to one and not the other shows up here rather than as a
   * button that fails when a trainer presses it.
   */
  it.each(FLARE_KINDS)('the API agrees with flareCarriesBoss for a %s', async (kind) => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind, createdBy: author.id });

    const { status } = await patch(author, flare.id, { action: 'edit', boss: 'Mewtwo' });

    expect(status).toBe(flareCarriesBoss(kind) ? 200 : 422);
  });

  it.each(FLARE_KINDS)('the API agrees with flareCarriesTier for a %s', async (kind) => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind, createdBy: author.id });

    const { status } = await patch(author, flare.id, { action: 'edit', tier: '5' });

    expect(status).toBe(flareCarriesTier(kind) ? 200 : 422);
  });

  it.each(FLARE_KINDS)('POST keeps a boss on a %s exactly when the helper says so', async (kind) => {
    const member = await seedUser(env.DB, { role: 'member' });
    const res = await SELF.fetch(
      await asUser(env.DB, member, 'https://pogotxk.test/api/flares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, boss: 'Mewtwo' }),
      }),
    );
    const { flare } = (await res.json()) as { flare: { boss: string | null } };

    expect(flare.boss).toBe(flareCarriesBoss(kind) ? 'Mewtwo' : null);
  });
});

describe('POST drops what edit refuses — the asymmetry, stated once', () => {
  it('creating a trade with a tier succeeds and stores null; editing one 422s', async () => {
    const member = await seedUser(env.DB, { role: 'member' });

    const created = await SELF.fetch(
      await asUser(env.DB, member, 'https://pogotxk.test/api/flares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'trade', tier: '5' }),
      }),
    );
    expect(created.status).toBe(201);
    const { flare } = (await created.json()) as { flare: { id: number; tier: string | null } };
    expect(flare.tier).toBeNull();

    expect((await patch(member, flare.id, { action: 'edit', tier: '5' })).status).toBe(422);
  });
});

describe('editing a flare that is over answers 410', () => {
  it('closed by hand', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'raid', createdBy: author.id, closed: true });

    expect((await patch(author, flare.id, { action: 'edit', boss: 'Mewtwo' })).status).toBe(410);
  });

  it('lapsed on its own', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'raid', createdBy: author.id, expired: true });

    expect((await patch(author, flare.id, { action: 'edit', boss: 'Mewtwo' })).status).toBe(410);
  });

  it('a flare that never existed is 404', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    expect((await patch(author, 4242, { action: 'edit', boss: 'Mewtwo' })).status).toBe(404);
  });

  it('403 beats 410 for somebody who was never allowed to edit it', async () => {
    // Authorisation runs before the liveness check, so a stranger learns they
    // may not touch the flare rather than learning when it ended.
    const author = await seedUser(env.DB, { role: 'member' });
    const stranger = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'raid', createdBy: author.id, closed: true });

    expect((await patch(stranger, flare.id, { action: 'edit', boss: 'x' })).status).toBe(403);
  });
});

/* -------------------------------------------------------------------- close */

describe('closing', () => {
  it('stands a live flare down and takes it off the board', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { createdBy: author.id });

    const { status, body } = await patch(author, flare.id, { action: 'close' });

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: flare.id, closed: true });
    expect((await stored(flare.id))?.closed_at).not.toBeNull();

    const board = (await (await SELF.fetch('https://pogotxk.test/api/flares')).json()) as {
      flares: unknown[];
    };
    expect(board.flares).toEqual([]);
  });

  it('closing a flare that has already ended is allowed, deliberately', async () => {
    /*
     * There is no 410 here and there must not be. Close is what settles the
     * flare's Discord embed, and a lapsed flare's embed is precisely the one
     * still advertising a raid that is over — 410 would refuse the only
     * request that tidies it. It also keeps a double-tap on Close idempotent
     * rather than an error toast.
     */
    const author = await seedUser(env.DB, { role: 'member' });
    const expired = await seedFlare(env.DB, { createdBy: author.id, expired: true });

    const { status, body } = await patch(author, expired.id, { action: 'close' });

    expect(status).toBe(200);
    expect(body.closed).toBe(true);
  });

  it('closing twice does not move closed_at', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { createdBy: author.id, closedAt: iso(Date.now() - 60_000) });

    const first = (await stored(flare.id))?.closed_at;
    expect((await patch(author, flare.id, { action: 'close' })).status).toBe(200);

    expect((await stored(flare.id))?.closed_at).toBe(first);
  });

  it('a flare that never existed is 404', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    expect((await patch(author, 4242, { action: 'close' })).status).toBe(404);
  });
});

/* ------------------------------------------------------- the alter matrix */

/**
 * The API's answer for each cell, next to what `mayAlterFlare` tells the client
 * to render. The client mirror is already unit-tested in
 * scripts/test-flare-permissions.ts; what is not tested anywhere else is that
 * the API agrees with it. A cell where they disagree is a button that fails the
 * moment a trainer presses it.
 */
const MATRIX: {
  label: string;
  role: Role;
  owns: boolean;
  allowed: boolean;
}[] = [
  { label: 'the trainer who raised it', role: 'member', owns: true, allowed: true },
  { label: 'a different member', role: 'member', owns: false, allowed: false },
  { label: 'an ambassador on their own flare', role: 'ambassador', owns: true, allowed: true },
  { label: "an ambassador on someone else's", role: 'ambassador', owns: false, allowed: true },
  { label: 'an admin on their own flare', role: 'admin', owns: true, allowed: true },
  { label: "an admin on someone else's", role: 'admin', owns: false, allowed: true },
  // A member demoted to guest keeps the ability to stand down what they
  // raised: `assertMayAlter` asks requireUser, not requireRole, and the client
  // mirror takes no role for the owner branch either.
  { label: 'a demoted author, on their own flare', role: 'guest', owns: true, allowed: true },
  { label: 'a guest on a flare they did not raise', role: 'guest', owns: false, allowed: false },
];

describe.each(['edit', 'close'] as const)('mayAlterFlare via %s', (action) => {
  const payload = action === 'edit' ? { action: 'edit', boss: 'Mewtwo' } : { action: 'close' };
  const kind: FlareKind = 'raid';

  it.each(MATRIX)('$label', async ({ role, owns, allowed }) => {
    const author = await seedUser(env.DB, { role: 'member' });
    const actor = owns ? author : await seedUser(env.DB, { role });
    if (owns) await env.DB.prepare('UPDATE users SET role = ?2 WHERE id = ?1').bind(author.id, role).run();

    const flare = await seedFlare(env.DB, { kind, createdBy: author.id });

    const { status } = await patch(actor, flare.id, payload);

    expect(status).toBe(allowed ? 200 : 403);

    // The client's own gate, given the same facts. A mismatch here is a button
    // rendered for an action the API will refuse, or withheld for one it allows.
    expect(mayAlterFlare({ id: author.id, name: 'a', team: null }, actor.id, role === 'ambassador' || role === 'admin')).toBe(
      allowed,
    );
  });

  it('anonymous is refused', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind, createdBy: author.id });

    expect((await patch(null, flare.id, payload)).status).toBe(401);
  });

  it('an authorless flare is nobody-may-touch, except a moderator', async () => {
    // The trap `mayAlterFlare` documents: `a?.id === b?.id` is true when both
    // are absent, which would hand every member a button on every flare whose
    // author was deleted.
    const member = await seedUser(env.DB, { role: 'member' });
    const ambassador = await seedUser(env.DB, { role: 'ambassador' });
    const orphan = await seedFlare(env.DB, { kind, createdBy: null });

    expect((await patch(member, orphan.id, payload)).status).toBe(403);
    expect(mayAlterFlare(null, member.id, false)).toBe(false);

    expect((await patch(ambassador, orphan.id, payload)).status).toBe(200);
    expect(mayAlterFlare(null, ambassador.id, true)).toBe(true);
  });
});

describe('moderation is audited, routine use is not', () => {
  it('an ambassador closing someone else flare leaves a row', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const ambassador = await seedUser(env.DB, { role: 'ambassador' });
    const flare = await seedFlare(env.DB, { createdBy: author.id });

    await patch(ambassador, flare.id, { action: 'close' });

    const row = await env.DB.prepare(
      "SELECT actor_id, action, entity_id, diff_json FROM audit_log WHERE entity = 'flare'",
    ).first<{ actor_id: number; action: string; entity_id: string; diff_json: string }>();

    expect(row?.actor_id).toBe(ambassador.id);
    expect(row?.action).toBe('update');
    expect(row?.entity_id).toBe(String(flare.id));
    expect(JSON.parse(row!.diff_json)).toMatchObject({ byModerator: true });
  });

  it('an ambassador editing someone else flare leaves a row', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const ambassador = await seedUser(env.DB, { role: 'ambassador' });
    const flare = await seedFlare(env.DB, { kind: 'raid', createdBy: author.id });

    await patch(ambassador, flare.id, { action: 'edit', boss: 'Mewtwo' });

    expect((await auditRows())?.n).toBe(1);
  });

  it('closing your own flare leaves nothing', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { createdBy: author.id });

    await patch(author, flare.id, { action: 'close' });

    expect((await auditRows())?.n).toBe(0);
  });

  it('editing your own flare leaves nothing', async () => {
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { kind: 'raid', createdBy: author.id });

    await patch(author, flare.id, { action: 'edit', boss: 'Mewtwo' });

    expect((await auditRows())?.n).toBe(0);
  });

  it('a second close by a moderator does not audit again', async () => {
    // The audit rides inside the `closed_at IS NULL` branch, so a repeated
    // close is a no-op end to end rather than a stream of identical rows.
    const author = await seedUser(env.DB, { role: 'member' });
    const ambassador = await seedUser(env.DB, { role: 'ambassador' });
    const flare = await seedFlare(env.DB, { createdBy: author.id });

    await patch(ambassador, flare.id, { action: 'close' });
    await patch(ambassador, flare.id, { action: 'close' });

    expect((await auditRows())?.n).toBe(1);
  });
});
