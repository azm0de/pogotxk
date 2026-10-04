/**
 * `DELETE /api/account` for the two kinds of identity it now tells apart.
 *
 * A standalone admin (`discord_id` = `admin:<name>`) has no Discord account
 * behind it: its password credential is its only way in, and deletion removes
 * that credential on purpose. The account menu already hid the button for
 * those identities, but the route did not refuse, so one request could lock an
 * owner out of their own site (admin audit, 2026-10, B-16). It now answers 403
 * and touches nothing. An ordinary deletion now leaves a `delete` audit row —
 * carrying no name, which is the point of the request.
 *
 * Lives under test/admin because it is an admin-audit finding; the rest of the
 * account endpoint's behaviour is `test/auth/account.test.ts`'s.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  authCookie,
  readCredential,
  seedAdminCredential,
  seedSession,
  seedUser,
} from '../helpers/factories';
import { auditRows, ORIGIN, rowCount } from './surface';

function deleteAccount(token: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/account`, {
    method: 'DELETE',
    headers: { origin: ORIGIN, cookie: authCookie(token) },
    redirect: 'manual',
  });
}

describe('DELETE /api/account', () => {
  it('refuses a standalone admin and leaves the account, its password and its session alone', async () => {
    const owner = await seedUser(env.DB, { discordId: 'admin:owner', role: 'admin', roleLocked: true });
    await seedAdminCredential(env.DB, owner);
    const token = await seedSession(env.DB, owner);

    const res = await deleteAccount(token);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Admin accounts are managed with set:password' });
    expect(res.headers.get('set-cookie')).toBeNull();

    const row = await env.DB.prepare('SELECT discord_id, role FROM users WHERE id = ?1')
      .bind(owner.id)
      .first<{ discord_id: string; role: string }>();
    expect(row).toEqual({ discord_id: 'admin:owner', role: 'admin' });
    expect(await readCredential(env.DB, owner)).not.toBeNull();
    expect(await rowCount('sessions', 'user_id = ?1', owner.id)).toBe(1);
    expect(await rowCount('audit_log')).toBe(0);
  });

  it('still deletes a Discord account that happens to be an admin', async () => {
    // About the identity, not the role — see `isStandaloneAdmin`.
    const admin = await seedUser(env.DB, { discordId: '100000000000000777', role: 'admin' });
    const token = await seedSession(env.DB, admin);

    const res = await deleteAccount(token);

    expect(res.status).toBe(200);
    expect(await rowCount('users', 'id = ?1 AND discord_id = ?2', admin.id, `deleted:${admin.id}`)).toBe(1);
  });

  it('records a delete audit row for a member, with nothing identifying in it', async () => {
    const member = await seedUser(env.DB, {
      discordId: '100000000000000888',
      username: 'findable-name',
      trainerName: 'FindableTrainer',
    });
    const token = await seedSession(env.DB, member);

    const res = await deleteAccount(token);

    expect(res.status).toBe(200);
    const rows = await auditRows();
    expect(rows).toEqual([
      {
        id: expect.any(Number),
        actor_id: member.id,
        action: 'delete',
        entity: 'account',
        entity_id: String(member.id),
        diff_json: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('findable');
    expect(JSON.stringify(rows)).not.toContain('100000000000000888');
  });
});
