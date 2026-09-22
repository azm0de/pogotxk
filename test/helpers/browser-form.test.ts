/**
 * Tests for `browser-form.ts`, because the form tests built on it are only as
 * honest as its idea of what a browser sends.
 *
 * The one to protect is the switch in `formOrigin`. A version that always
 * answered with the site's origin would let every form test in the suite pass
 * whatever the pages said — which is exactly the state the suite was in while
 * both admin reset forms were refusing every real browser.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, effectivePolicy, formOrigin, parsePage } from './browser-form';

const PAGE = new URL('https://pogotxk.test/admin/reset');
const SAME = 'https://pogotxk.test/api/auth/admin-reset';
const DOWNGRADE = 'http://pogotxk.test/api/auth/admin-reset';
const ELSEWHERE = 'https://elsewhere.test/collect';
const ORIGIN = PAGE.origin;

describe('the Origin a form POST carries, by referrer policy', () => {
  it.each<[policy: string, action: string, origin: string]>([
    // The regression itself.
    ['no-referrer', SAME, 'null'],
    // The fix: the real origin for a same-origin HTTPS post, and null only on
    // a downgrade to plain HTTP.
    ['strict-origin', SAME, ORIGIN],
    ['strict-origin', ELSEWHERE, ORIGIN],
    ['strict-origin', DOWNGRADE, 'null'],
    ['strict-origin-when-cross-origin', SAME, ORIGIN],
    ['strict-origin-when-cross-origin', DOWNGRADE, 'null'],
    ['no-referrer-when-downgrade', SAME, ORIGIN],
    ['no-referrer-when-downgrade', DOWNGRADE, 'null'],
    ['same-origin', SAME, ORIGIN],
    ['same-origin', ELSEWHERE, 'null'],
    // Everything else leaves the header alone, even on a downgrade.
    ['origin', DOWNGRADE, ORIGIN],
    ['origin-when-cross-origin', ELSEWHERE, ORIGIN],
    ['unsafe-url', DOWNGRADE, ORIGIN],
  ])('%s, posting to %s, sends Origin: %s', (policy, action, expected) => {
    expect(formOrigin(policy, PAGE, new URL(action))).toBe(expected);
  });
});

describe('the policy a form submission inherits', () => {
  it('is the header when nothing overrides it', () => {
    expect(effectivePolicy('strict-origin', [], '')).toEqual({
      policy: 'strict-origin',
      source: 'header',
    });
  });

  it('takes the last token a browser recognises from a header list', () => {
    expect(effectivePolicy('no-referrer, strict-origin', [], '').policy).toBe('strict-origin');
    expect(effectivePolicy('strict-origin, not-a-policy', [], '').policy).toBe('strict-origin');
    expect(effectivePolicy('No-Referrer', [], '').policy).toBe('no-referrer');
  });

  it('lets <meta name="referrer"> override the header, legacy keywords included', () => {
    // `never` is the old spelling of `no-referrer`, and it still nulls Origin.
    expect(effectivePolicy('strict-origin', ['never'], '')).toEqual({
      policy: 'no-referrer',
      source: 'meta',
    });
    // The last one a browser recognises wins; one it does not is skipped.
    expect(effectivePolicy(null, ['no-referrer', 'strict-origin', 'nonsense'], '').policy).toBe(
      'strict-origin',
    );
  });

  it('ignores a meta value no browser would recognise', () => {
    expect(effectivePolicy('strict-origin', ['nonsense'], '')).toEqual({
      policy: 'strict-origin',
      source: 'header',
    });
  });

  it('lets rel="noreferrer" on the form itself override both', () => {
    // The other way to reintroduce the bug: somebody "hardening" the form.
    expect(effectivePolicy('strict-origin', ['unsafe-url'], 'noopener noreferrer')).toEqual({
      policy: 'no-referrer',
      source: 'form rel',
    });
  });

  it('falls back to the browser default when the page sets nothing', () => {
    expect(effectivePolicy(null, [], '')).toEqual({ policy: DEFAULT_POLICY, source: 'default' });
    expect(formOrigin(DEFAULT_POLICY, PAGE, new URL(SAME))).toBe(ORIGIN);
  });
});

describe('reading a page', () => {
  it('decodes the real form and meta, and ignores decoys in a comment or a script', async () => {
    const page = await parsePage(`
      <head><meta content="No-Referrer" name="referrer"></head>
      <!-- <form method="post" action="/decoy"><meta name="referrer" content="unsafe-url"> -->
      <form action="/x?a=1&amp;b=2" METHOD="POST" rel="noreferrer">
        <input type="hidden" name="token" value="a&amp;b&#39;c">
        <input name="email">
        <input type="checkbox" name="remember">
        <input type="password" name="old" disabled>
        <button type="submit">Go</button>
      </form>
      <script>const decoy = '<form method=post><input name=x>';</script>
    `);

    expect(page.metas).toEqual(['No-Referrer']);
    expect(page.forms).toHaveLength(1);

    const [form] = page.forms;
    expect(form!.method).toBe('post');
    expect(form!.action).toBe('/x?a=1&b=2');
    expect(form!.rel).toBe('noreferrer');
    // The unchecked box, the disabled field and the unnamed button are never
    // submitted by a browser, so they are not here either.
    expect(form!.controls).toEqual([
      { name: 'token', value: "a&b'c", hidden: true },
      { name: 'email', value: '', hidden: false },
    ]);
    expect(form!.unmodelled).toEqual([]);
  });

  it('records what it cannot model rather than guessing at it', async () => {
    const page = await parsePage(`
      <form method="post"><textarea name="note"></textarea><button name="go">Go</button></form>
    `);
    expect(page.forms[0]!.unmodelled).toEqual(['<textarea>', '<button>']);
  });
});
