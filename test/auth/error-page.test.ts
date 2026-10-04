/**
 * `/auth/error`, where the Discord callback sends a sign-in that failed.
 *
 * Admin audit, 2026-10, A-14: the page printed `?reason=` after "Discord
 * reported:". Escaped, so never a script — but a reason is a query parameter,
 * so anyone could link to this page with any sentence they liked and have it
 * shown under our heading on our domain. Content spoofing.
 *
 * Now only an allowlisted reason becomes prose, an OAuth-shaped error code may
 * appear as a `<code>` detail, and everything else gets the generic lede and
 * nothing more.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'https://pogotxk.test';

async function page(reason?: string): Promise<string> {
  const query = reason === undefined ? '' : `?reason=${encodeURIComponent(reason)}`;
  const res = await SELF.fetch(`${ORIGIN}/auth/error${query}`, { redirect: 'manual' });
  expect(res.status).toBe(200);
  return res.text();
}

const GENERIC = 'Discord sign-in did not complete';

describe('/auth/error', () => {
  it('explains a reason it knows, in its own words', async () => {
    const html = await page('access_denied');

    expect(html).toContain('You cancelled the Discord sign-in');
    expect(html).not.toContain('Discord reported');
  });

  it('shows an unknown OAuth error code only as a code', async () => {
    const html = await page('temporarily_unavailable');

    expect(html).toContain(GENERIC);
    // `<code` rather than `<code>`: Astro adds its scoping attribute.
    expect(html).toMatch(/<code[^>]*>temporarily_unavailable<\/code>/);
  });

  it.each([
    ['a sentence', 'Your account is suspended. Call 555-0100 to restore it'],
    ['markup', '<b>urgent</b>'],
    ['a code-ish word with a space', 'invalid_request now'],
    ['upper case', 'INVALID_REQUEST'],
    ['an exception message from the callback', 'Discord token exchange failed: 500'],
  ])('prints nothing of %s', async (_label, reason) => {
    const html = await page(reason);

    expect(html).toContain(GENERIC);
    expect(html).not.toContain('Discord reported');
    // Not escaped-and-shown: absent, in either form.
    const escaped = reason.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(html).not.toContain(reason);
    expect(html).not.toContain(escaped);
  });

  it('does not find a prototype property by name', async () => {
    // A bare `EXPLANATIONS[reason]` would find `Object.prototype.constructor`.
    const html = await page('constructor');

    expect(html).not.toContain('function Object');
    expect(html).toContain(GENERIC);
  });

  it('says the generic thing with no reason at all', async () => {
    const html = await page();

    expect(html).toContain(GENERIC);
    expect(html).not.toContain('Discord reported');
  });
});
