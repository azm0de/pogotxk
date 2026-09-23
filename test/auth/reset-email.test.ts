/**
 * The reset mail's template, and the sender's payload, tested directly.
 *
 * `admin-reset.test.ts` proves what a real request makes Resend send. This file
 * proves the rules that have to hold for *any* input, which a request cannot
 * reach: the template is handed hostile values straight, and the sender is
 * driven with a made-up configuration and a stubbed `fetch`.
 *
 * NOTHING HERE CAN SEND MAIL. `sendEmail` is only ever called after
 * `captureResend()` has replaced `fetch` with a stub that records the request
 * and answers it itself; `test/setup.ts` reinstalls a `fetch` that throws
 * before every test regardless, and `unstubGlobals` removes the stub after each
 * one. The configuration is a plain object built here — the real bindings stay
 * blank, which `00-safety.test.ts` asserts.
 */

import { describe, expect, it, vi } from 'vitest';
import { emailFrom, fromHeader, SENDER_NAME, sendEmail } from '~/lib/notify/email';
import {
  escapeHtml,
  RESET_SUBJECT,
  RESET_TTL_MINUTES,
  resetMessage,
} from '~/lib/notify/reset-email';

/** A link in the shape `resetLink()` builds, with a token that opens nothing. */
const LINK = `https://pogotxk.test/admin/reset/${'0123456789abcdef'.repeat(4)}`;

/**
 * Every element a real HTML parser finds, by tag name, in document order.
 * Comments are not elements, so Outlook's conditional blocks do not appear —
 * which is the point: this is what a client would actually build.
 */
async function elementsOf(html: string): Promise<string[]> {
  const tags: string[] = [];
  await new HTMLRewriter()
    .on('*', {
      element(el) {
        tags.push(el.tagName);
      },
    })
    .transform(new Response(html))
    .arrayBuffer();
  return tags;
}

/* -------------------------------------------------------- hostile values */

describe('the template, fed hostile values directly', () => {
  /*
   * Every character that means something in HTML, in both values: a quote of
   * each kind to leave an attribute, angle brackets to open a tag, and an
   * ampersand to start an entity. Neither value can look like this in
   * production — the name comes from the setter, which admits none of them,
   * and the link from `resetLink` — which is why they are fed in here, where
   * nothing stands in front of the template.
   */
  const NAME = `ad"min'<b>&amp;</b>`;
  const HOSTILE_LINK = `https://pogotxk.test/admin/reset/x"><img src=x onerror=alert(1)>&'y`;

  it('escapes the five characters that matter, exactly', () => {
    expect(escapeHtml(`"<>&'`)).toBe('&quot;&lt;&gt;&amp;&#39;');
    expect(escapeHtml('justin')).toBe('justin');
    // An existing entity is escaped again, so an escaped value can never be
    // mistaken for markup by being read twice.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('never lets either value out of its text or its attribute', async () => {
    const mail = resetMessage({ link: HOSTILE_LINK, username: NAME });

    // The raw values appear nowhere in the HTML...
    expect(mail.html).not.toContain(NAME);
    expect(mail.html).not.toContain(HOSTILE_LINK);

    // ...their escaped forms appear exactly where they belong: the name in its
    // <strong>, the link in both hrefs and as the printed text...
    expect(mail.html).toContain(`<strong>${escapeHtml(NAME)}</strong>`);
    expect(mail.html.split(`href="${escapeHtml(HOSTILE_LINK)}"`)).toHaveLength(3);
    expect(mail.html).toContain(`>${escapeHtml(HOSTILE_LINK)}</a>`);

    // ...and a real parser agrees: the markup the values tried to inject never
    // became elements.
    const tags = await elementsOf(mail.html);
    expect(tags).not.toContain('img');
    expect(tags).not.toContain('b');
    expect(tags.filter((tag) => tag === 'a')).toHaveLength(2);
    expect(tags.filter((tag) => tag === 'strong')).toHaveLength(1);
  });

  it('carries the values verbatim in the text part, where nothing is markup', () => {
    const mail = resetMessage({ link: HOSTILE_LINK, username: NAME });

    expect(mail.text).toContain(`"${NAME}"`);
    expect(mail.text).toContain(HOSTILE_LINK);
  });

  it.each([
    ['a javascript: link', 'javascript:alert(1)'],
    ['a data: link', 'data:text/html,<script>alert(1)</script>'],
    ['a relative link', '/admin/reset/abc'],
    ['no link at all', ''],
  ])('refuses %s outright', (_label, link) => {
    // Escaping keeps a value inside its attribute. It does nothing about a
    // `javascript:` URL that is already inside one.
    expect(() => resetMessage({ link, username: 'justin' })).toThrow(/reset mail/);
  });

  it.each([
    ['a line break', 'just\nin'],
    ['a carriage return', 'just\rin'],
    ['a tab', 'just\tin'],
    ['a null', 'just\u0000in'],
  ])('refuses a name with %s — the one way a value could rearrange plain text', (_l, username) => {
    expect(() => resetMessage({ link: LINK, username })).toThrow(/control character/);
  });

  it('checks the link string itself for control characters, not the parsed URL', () => {
    // The URL parser strips a newline and parses happily, so a check on the
    // parsed URL would pass a link that breaks the text part's layout.
    expect(() => new URL(`${LINK}\n`)).not.toThrow();
    expect(() => resetMessage({ link: `${LINK}\n`, username: 'justin' })).toThrow(
      /control character/,
    );
  });
});

/* ---------------------------------------------------- what the HTML holds */

describe('what the HTML may contain', () => {
  const mail = resetMessage({ link: LINK, username: 'justin' });

  it('is built from a small, fixed set of elements — no script, form, frame or image', async () => {
    const allowed = new Set([
      'html', 'head', 'meta', 'title', 'style', 'body',
      'div', 'table', 'tr', 'td', 'h1', 'p', 'a', 'strong',
    ]);
    const tags = new Set(await elementsOf(mail.html));

    expect([...tags].filter((tag) => !allowed.has(tag))).toEqual([]);
  });

  it('fetches nothing when it is opened: no image, font, stylesheet or url()', () => {
    // A fetch on open is a read receipt carrying the reader's IP, from any
    // origin, ours included. The wordmark is typeset for exactly this reason.
    for (const pattern of [
      /<script/i,
      /<img/i,
      /<link\b/i,
      /<iframe/i,
      /<form/i,
      /<object/i,
      /<embed/i,
      /<video/i,
      /<audio/i,
      /\bsrc\s*=/i,
      /srcset/i,
      /url\s*\(/i,
      /@import/i,
      /@font-face/i,
      /\bbackground\s*=/i,
    ]) {
      expect(mail.html, String(pattern)).not.toMatch(pattern);
    }
    // And no `http:` at all on an https link — not as a resource, not as a link.
    expect(mail.html).not.toMatch(/http:/i);
  });

  it('links to exactly one place, twice: the button and the printed link', () => {
    const hrefs = [...mail.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([LINK, LINK]);
  });

  it('is marked up for a screen reader: a language, a title, one heading, no grids', () => {
    expect(mail.html).toMatch(/<html lang="en"/);
    expect(mail.html).toContain(`<title>${RESET_SUBJECT}</title>`);
    expect(mail.html.match(/<h1\b/g)).toHaveLength(1);

    // Every table says it is layout — Outlook's conditional one included, since
    // Outlook is the client that renders it.
    const tables = mail.html.match(/<table\b[^>]*>/g) ?? [];
    expect(tables.length).toBeGreaterThanOrEqual(4);
    for (const table of tables) expect(table).toContain('role="presentation"');
  });

  it('sets no text below 16px, in any unit', () => {
    const sizes = [...mail.html.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((size) => size < 16)).toEqual([]);
    expect(mail.html).not.toMatch(/font-size:\s*[\d.]+\s*(?:em|rem|%|pt)/i);
  });

  it('holds up in dark mode: it declares both schemes and carries the site’s dark tokens', () => {
    expect(mail.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(mail.html).toContain('@media (prefers-color-scheme: dark)');
    // `--bg-panel` and `--text` from global.css's dark block.
    expect(mail.html).toContain('#1e1e22');
    expect(mail.html).toContain('#f2f2f4');

    // For the clients that force their own dark mode instead: every element
    // that holds text sets its own colour against its own background, so an
    // inverter never has to guess what a piece of text was sitting on.
    // (`<strong>` inherits its paragraph's; `color:` is matched after `;` or
    // `"` so that `background-color:` cannot satisfy it.)
    const opening = mail.html.match(/<(?:h1|p|a)\b[^>]*>/g) ?? [];
    expect(opening.length).toBeGreaterThanOrEqual(8);
    for (const tag of opening) expect(tag, tag).toMatch(/[;"]color:#[0-9a-f]{6}/);

    // The two cells that hold text directly: the wordmark and the footer line.
    const cells = mail.html.match(/<td\b[^>]*>[^<]+<\/td>/g) ?? [];
    expect(cells).toHaveLength(2);
    for (const cell of cells) expect(cell).toMatch(/[;"]color:#[0-9a-f]{6}/);
  });

  it('says in HTML what it says in text, sentence for sentence', () => {
    for (const phrase of [
      'Someone asked to reset the password for a PoGo TXK admin account.',
      'justin',
      'You can sign in with that username or with this email address.',
      `The link works once and stops working after ${RESET_TTL_MINUTES} minutes.`,
      'Setting a new password signs the account out everywhere it is signed in.',
      'If you did not ask for this, ignore this email. Nothing has changed, and the link expires on its own.',
    ]) {
      expect(mail.text, phrase).toContain(phrase);
      expect(mail.html, phrase).toContain(phrase);
    }
  });

  it('keeps the subject it has always had', () => {
    expect(mail.subject).toBe('Reset your PoGo TXK admin password');
    expect(RESET_TTL_MINUTES).toBe(30);
  });
});

/* -------------------------------------------------------------- the sender */

describe('the sender, with a made-up configuration and a stubbed fetch', () => {
  /** Not the real bindings, which stay blank. A key no one could mistake for real. */
  const configured = {
    RESEND_API_KEY: 'test-resend-key-not-a-real-one',
    RESEND_FROM: 'noreply@pogotxk.test',
  } as unknown as Env;

  /**
   * Stands in for Resend and refuses every other host, like `mockResend` in
   * `admin-reset.test.ts`. Records the URL of every attempt, so a test can
   * prove that none was made.
   */
  function captureResend(): { bodies: Record<string, unknown>[]; urls: string[] } {
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init);
      urls.push(request.url);
      if (new URL(request.url).hostname !== 'api.resend.com') {
        throw new Error(`captureResend: refused ${request.url}`);
      }
      bodies.push(
        JSON.parse(new TextDecoder().decode(await request.arrayBuffer())) as Record<string, unknown>,
      );
      return new Response(JSON.stringify({ id: 'test-message-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { bodies, urls };
  }

  it('sends text and html together, from "PoGo TXK <address>"', async () => {
    const resend = captureResend();
    const mail = resetMessage({ link: LINK, username: 'justin' });

    const outcome = await sendEmail(configured, {
      to: 'admin@example.test',
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });

    expect(outcome).toBe('sent');
    expect(resend.bodies).toEqual([
      {
        from: 'PoGo TXK <noreply@pogotxk.test>',
        to: 'admin@example.test',
        subject: 'Reset your PoGo TXK admin password',
        text: mail.text,
        html: mail.html,
      },
    ]);
  });

  it('sends a text-only message exactly as before, with no html key at all', async () => {
    const resend = captureResend();

    await sendEmail(configured, { to: 'admin@example.test', subject: 's', text: 't' });

    expect(Object.keys(resend.bodies[0]!).sort()).toEqual(['from', 'subject', 'text', 'to']);
  });

  it('refuses a message with no plain-text part, before making any request', async () => {
    // Resend would invent a text part from the HTML. The text part is the one
    // promise every reader, in every client, can rely on, so it is ours.
    const resend = captureResend();

    for (const text of ['', '   \n  ']) {
      const outcome = await sendEmail(configured, {
        to: 'admin@example.test',
        subject: 's',
        text,
        html: '<p>only html</p>',
      });
      expect(outcome).toBe('disabled');
    }
    expect(resend.urls).toEqual([]);
  });

  it('still refuses a display name in RESEND_FROM, which leaves the sender off', async () => {
    // The name is added in code, from a constant. One typed into configuration
    // is a header-injection shape, and is refused rather than trusted.
    const resend = captureResend();
    const named = {
      RESEND_API_KEY: 'test-resend-key-not-a-real-one',
      RESEND_FROM: 'PoGo TXK <noreply@pogotxk.test>',
    } as unknown as Env;

    expect(emailFrom(named)).toBeNull();
    expect(await sendEmail(named, { to: 'admin@example.test', subject: 's', text: 't' })).toBe(
      'disabled',
    );
    expect(resend.urls).toEqual([]);
  });

  it('builds the From from a constant name that needs no quoting', () => {
    // No RFC 5322 special — quote, comma, angle bracket, colon, semicolon,
    // at sign, backslash, parenthesis, dot — and nothing that ends a header.
    expect(SENDER_NAME).toMatch(/^[A-Za-z0-9 ]+$/);
    expect(fromHeader('noreply@pogotxk.test')).toBe('PoGo TXK <noreply@pogotxk.test>');
  });
});
