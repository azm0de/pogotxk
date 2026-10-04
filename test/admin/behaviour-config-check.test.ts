/**
 * `GET /api/admin/config-check` — what it reports, and to whom.
 *
 * Since the admin audit (2026-10, B-09/B-10) it answers a signed-in admin and
 * nobody else: the import bearer token no longer opens it, and an ambassador
 * gets the route's own 403. It lists every variable the code reads — the bot
 * token and the reset mailer were missing, so the "similar names" check
 * accused a working `DISCORD_BOT_TOKEN` of being a typo — and it reports the
 * `LIVE` binding with the others.
 *
 * The values themselves must never appear. The test bindings are fixed, known
 * strings (vitest.config.ts), which is what makes "none of them is in the
 * body" an assertion rather than a hope.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ORIGIN, signedIn } from './surface';

interface ConfigVar {
  name: string;
  present: boolean;
  required: boolean;
  length: number;
  hasSurroundingWhitespace: boolean;
  hasQuotes: boolean;
  note: string;
}

interface ConfigBody {
  ok: boolean;
  bindings: Record<string, boolean>;
  webhook: { present: boolean; accepted: boolean };
  vars: ConfigVar[];
  missingRequired: string[];
  unrecognisedSimilarNames: string[];
  hint: string;
}

/** The fixed fake values vitest.config.ts binds. None may be echoed back. */
const SECRET_VALUES = ['test-client-id', 'test-client-secret', 'test-guild-id', 'test-import-token'];

describe('GET /api/admin/config-check', () => {
  it('reports presence, never values, in the documented shape', async () => {
    const admin = await signedIn('admin');

    const res = await admin.send('/api/admin/config-check');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const text = await res.text();
    for (const value of SECRET_VALUES) expect(text).not.toContain(value);

    const body = JSON.parse(text) as ConfigBody;
    expect(Object.keys(body).sort()).toEqual(
      ['bindings', 'hint', 'missingRequired', 'ok', 'unrecognisedSimilarNames', 'vars', 'webhook'].sort(),
    );
    expect(body.bindings).toEqual({ DB: true, MEDIA: true, CACHE: true, LIVE: true });
    expect(body.webhook).toEqual({ present: false, accepted: false });

    for (const v of body.vars) {
      expect(Object.keys(v).sort()).toEqual(
        ['hasQuotes', 'hasSurroundingWhitespace', 'length', 'name', 'note', 'present', 'required'].sort(),
      );
    }

    const byName = new Map(body.vars.map((v) => [v.name, v]));
    expect(byName.get('DISCORD_CLIENT_SECRET')).toMatchObject({
      present: true,
      required: true,
      length: 'test-client-secret'.length,
    });
    for (const name of ['DISCORD_BOT_TOKEN', 'RESEND_API_KEY', 'RESEND_FROM']) {
      // Listed, optional, and blank in the test bindings.
      expect(byName.get(name), name).toMatchObject({ present: false, required: false });
    }
    expect(byName.get('IMPORT_TOKEN')).toMatchObject({ present: true, required: false });
    expect(body.missingRequired).toEqual([]);
    expect(body.ok).toBe(true);
  });

  it('never flags a name it reads as a suspected typo', async () => {
    const admin = await signedIn('admin');

    const body = (await (await admin.send('/api/admin/config-check')).json()) as ConfigBody;

    const listed = body.vars.map((v) => v.name);
    expect(listed).toContain('DISCORD_BOT_TOKEN');
    expect(body.unrecognisedSimilarNames).not.toContain('DISCORD_BOT_TOKEN');
    for (const name of listed) expect(body.unrecognisedSimilarNames).not.toContain(name);
  });

  it('refuses an ambassador with the route’s own 403', async () => {
    const ambassador = await signedIn('ambassador');

    const res = await ambassador.send('/api/admin/config-check');

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Requires admin' });
  });

  it('is not opened by the import bearer token', async () => {
    // Without a session the middleware refuses before the route runs …
    const anonymous = await SELF.fetch(`${ORIGIN}/api/admin/config-check`, {
      headers: { authorization: 'Bearer test-import-token' },
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: 'Forbidden' });

    // … and with an ambassador's session the token adds nothing.
    const ambassador = await signedIn('ambassador');
    const res = await ambassador.send('/api/admin/config-check', {
      headers: { authorization: 'Bearer test-import-token' },
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    for (const value of SECRET_VALUES) expect(text).not.toContain(value);
  });
});
