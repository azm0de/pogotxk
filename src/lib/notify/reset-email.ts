/**
 * The admin password-reset mail: its subject, its plain-text part, and — since
 * 2026-09-23, at the owner's request — a branded HTML part that rides
 * alongside the text, never instead of it.
 *
 * A module of its own rather than a function inside the route, for two
 * reasons. It writes HTML by hand, outside Astro's escaping, and that deserves
 * a file a reader can hold whole. And it has to load under plain `tsx`, so
 * `scripts/preview-reset-email.ts` can render the real thing for a person to
 * look at: no `cloudflare:workers`, no `~/` alias, nothing but a relative
 * import of the lifetime it quotes.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE HTML IS NOT ALLOWED TO CONTAIN
 * ---------------------------------------------------------------------------
 *
 * It exists to look like the site. It must not become a way to watch who opens
 * a password-reset mail, or a way to smuggle markup into one, so:
 *
 *   * **No remote resource of any kind.** No `<img>`, no web font, no
 *     stylesheet `<link>`, no `url()`. A client fetches those when the mail is
 *     opened, and a fetch on open is a read receipt carrying the reader's IP —
 *     the tracking pixel the plain-text rule in `email.ts` existed to prevent.
 *     Our own origin is no exception; see WHY A TEXT WORDMARK.
 *   * **No script, no form, no frame.** Most clients strip them. A template
 *     that relies on the client to strip is one client away from running
 *     something.
 *   * **Every interpolated value is escaped for where it lands.** There are
 *     two, the link and the login name. In the HTML both go through
 *     `escapeHtml`, which is right for text and for a double-quoted attribute
 *     alike, and the link is refused outright unless it is an absolute http(s)
 *     URL — an escaped `javascript:` is still a `javascript:` link. In the text
 *     part nothing needs escaping, but neither value may carry a control
 *     character, which is the one way a value could rearrange a plain-text
 *     mail. A refusal throws; the route composes this inside the work it has
 *     already arranged to swallow, so a throw can never change its answer.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MAIL NAMES THE ACCOUNT NOW
 * ---------------------------------------------------------------------------
 *
 * It used not to, on the argument that the link already identifies exactly one
 * account and the page behind it names that account. On 2026-09-23 an admin
 * reset his password twice from this mail and was then refused at
 * `/admin/login`, because he typed the address the mail had come to — the
 * only identifier the recovery flow had ever shown him. So the mail says the
 * login name, and that either it or the address will sign in.
 *
 * It discloses nothing new. Whoever can read this mailbox can already open the
 * link and read the name off the page behind it — that is the evidence the
 * whole flow is built on — and a login name is an identifier, not a secret:
 * the password and the lockout are the controls. The subject line and the
 * inbox preview text stay generic, so a lock-screen notification does not
 * carry it.
 *
 * ---------------------------------------------------------------------------
 * WHY A TEXT WORDMARK
 * ---------------------------------------------------------------------------
 *
 * The site's own header is typeset rather than drawn — "PoGo TXK" in the
 * signage face, white on the red bar, over the black band — so a typeset
 * wordmark is not a compromise here, it is how the site already writes its
 * name. The only raster logo, `/art/logo-txk-classic.webp`, is built on the
 * Pokémon GO logo, which the design rules keep off anything new (the owner's
 * call); and any image, even from our own origin, is a fetch on open. So the
 * mail carries no image at all.
 *
 * ---------------------------------------------------------------------------
 * BUILT FOR MAIL CLIENTS, NOT BROWSERS
 * ---------------------------------------------------------------------------
 *
 * Tables for layout, each marked `role="presentation"` so a screen reader does
 * not announce a grid. Styles inline, because clients drop or rewrite
 * `<style>` unpredictably; the two `<style>` blocks only add things a client
 * may safely ignore — a narrower gutter on a phone, and the dark palette. A
 * 600px column that narrows on a phone. A "bulletproof" button: the red is on
 * a table cell and the link inside it is padded, so the button keeps its shape
 * where a client ignores padding on a link (Outlook's `mso-padding-alt` covers
 * that one). And the full link printed under the button, for any client that
 * mangles buttons.
 *
 * The colours are the site's tokens written out, because a mail client has no
 * custom properties to resolve `var(--accent-solid)` with. Each is named below
 * with the pairs it is used in and their measured contrast; every text pairing
 * is 4.5:1 or better in both themes. Light is the default. Clients that honour
 * `prefers-color-scheme` (Apple Mail among them) get the site's own dark tokens
 * from the second `<style>` block. Clients that force their own dark mode
 * instead (the Gmail apps) recolour the mail themselves, which this survives
 * because every text colour is set explicitly against an explicit background —
 * there is no transparent surface for an inverter to guess about — and the two
 * red surfaces carry white text, which stays legible whichever way the red is
 * pushed.
 *
 * Web fonts are unreliable in mail, and a remote one is a fetch on open, so
 * the site's two faces are named first for anyone who has them installed and
 * each stack falls back to the platform's own UI face. Nothing is set below
 * 16px.
 */

import { RESET_TTL_MS } from '../auth/password-reset';

/** Unchanged since the first version of this mail, and tested as such. */
export const RESET_SUBJECT = 'Reset your PoGo TXK admin password';

/** Minutes, for the copy. Derived, so the mail and the TTL cannot disagree. */
export const RESET_TTL_MINUTES = Math.round(RESET_TTL_MS / 60_000);

export interface ResetMailInput {
  /** The absolute link from `resetLink()`. Refused unless it is http(s). */
  link: string;
  /** The account's login name, `admin_credentials.username`. */
  username: string;
}

export interface ResetMail {
  subject: string;
  /** Always present, always complete: the mail is readable from this alone. */
  text: string;
  /** The same message, dressed as the site. */
  html: string;
}

/* ---------------------------------------------------------------- escaping */

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes a value for HTML text and for a double-quoted attribute alike.
 *
 * All five characters, in both places, rather than a lighter set per context:
 * two contexts with two escapers is a mistake waiting to happen at the call
 * site, and over-escaping an attribute costs nothing. `&` is in the set, so an
 * escaped value can never be mistaken for markup by being escaped twice.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);
}

/**
 * True for C0 controls and DEL — a line break among them. Written as codepoint
 * maths rather than a character class, the same way `~/lib/auth/next` does,
 * because literal control bytes in source do not survive every editor.
 */
function hasControl(value: string): boolean {
  return [...value].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function plainValue(label: string, value: string): string {
  if (hasControl(value)) throw new Error(`reset mail: the ${label} contains a control character`);
  return value;
}

/**
 * The link, or a throw. An absolute http(s) URL and nothing else: escaping
 * keeps a value inside its attribute, and it does nothing about a `javascript:`
 * URL that is already inside one. `http:` is allowed for a local `wrangler
 * dev`, whose origin is plain HTTP; production's is not.
 */
function checkedLink(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error('reset mail: the link is not an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('reset mail: the link is not http(s)');
  }
  return plainValue('link', link);
}

/* ------------------------------------------------------------------ design */

/*
 * The site's tokens, as literals (see BUILT FOR MAIL CLIENTS). Every value is
 * an existing token from `src/styles/global.css`, not a new colour, and every
 * text pairing is measured — WCAG 2 contrast.
 */
const LIGHT = {
  page: '#f7f7f8', // --bg
  panel: '#ffffff', // --bg-panel
  plate: '#efeff1', // --bg-sunken, behind the printed link
  text: '#1d1d1f', // --text: 16.83 on panel, 14.66 on plate
  muted: '#5f5f68', // --text-muted: 6.32 on panel, 5.90 on page
  rule: '#e3e3e6', // --border: a hairline, never text
  brand: '#c8071c', // --accent-solid: the header bar and the button
  band: '#0f0f11', // --ink-900: the Poké Ball's black band under the bar
} as const;

/* The dark theme's values of the same tokens, for the `prefers-color-scheme`
   block. The two red surfaces are not here: `--accent-solid` is the same deep
   red in both themes, which is the point of it. */
const DARK = {
  page: '#141416', // --bg
  panel: '#1e1e22', // --bg-panel
  plate: '#191a1c', // --bg-sunken
  text: '#f2f2f4', // --text: 14.86 on panel, 15.58 on plate
  muted: '#a4a4ac', // --text-muted: 6.71 on panel, 7.43 on page
  rule: '#34343b', // --border
} as const;

/* White, on `--accent-solid` only: 5.99, both themes. */
const ON_BRAND = '#ffffff';

/* The site's two faces first, for anyone who has them installed, then each
   platform's own UI face. The mono stack is the design system's code face. */
const SIGN = "'Overpass', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const READ =
  "'Atkinson Hyperlegible Next', 'Atkinson Hyperlegible', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'Cascadia Mono', 'Segoe UI Mono', Menlo, Consolas, monospace";

/* Body copy: 16px on a 25px line, the site's 1.55 rounded to a pixel. */
const BODY = `font-family:${READ};font-size:16px;line-height:25px;`;

/* ----------------------------------------------------------------- the copy */

/*
 * The substance is the same in both parts, sentence for sentence, so a reader
 * of either gets the whole message: the account, the link, that it works once
 * and for thirty minutes, that using it signs the account out everywhere, and
 * what to do if they never asked. Short and plain — the people reading this
 * are not technical, and one of them is reading it because something already
 * went wrong.
 */
const ASKED = 'Someone asked to reset the password for a PoGo TXK admin account.';
const EITHER = 'You can sign in with that username or with this email address.';
const ONCE = `The link works once and stops working after ${RESET_TTL_MINUTES} minutes.`;
const EVERYWHERE = 'Setting a new password signs the account out everywhere it is signed in.';
/* Load-bearing rather than polite. Most people who get an unexpected reset mail
   have not been attacked — somebody typed the wrong address — and the useful
   instruction for them is to do nothing, which has to be said or they will
   click the link to "check". */
const IGNORE =
  'If you did not ask for this, ignore this email. Nothing has changed, and the link expires on its own.';

function textPart(link: string, username: string): string {
  // One paragraph per line, not hard-wrapped: a client wraps plain text to its
  // own width, and a line broken at 72 characters breaks twice on a phone.
  return [
    ASKED,
    '',
    `This is for the admin account "${username}". ${EITHER}`,
    '',
    'Choose a new password here:',
    '',
    link,
    '',
    `${ONCE} ${EVERYWHERE}`,
    '',
    IGNORE,
  ].join('\n');
}

function htmlPart(link: string, username: string): string {
  const href = escapeHtml(link);
  const name = escapeHtml(username);
  // The fixed copy goes through the same escaper. None of it needs it today;
  // the first "&" somebody writes into a sentence will.
  const asked = escapeHtml(ASKED);
  const either = escapeHtml(EITHER);
  const once = escapeHtml(ONCE);
  const everywhere = escapeHtml(EVERYWHERE);
  const ignore = escapeHtml(IGNORE);

  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<title>${escapeHtml(RESET_SUBJECT)}</title>
<style>
body { margin: 0; padding: 0; width: 100%; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
@media (max-width: 480px) {
  .pt-gutter { padding-left: 20px !important; padding-right: 20px !important; }
}
</style>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .pt-page { background-color: ${DARK.page} !important; }
  .pt-panel { background-color: ${DARK.panel} !important; }
  .pt-text { color: ${DARK.text} !important; }
  .pt-muted { color: ${DARK.muted} !important; }
  .pt-plate { background-color: ${DARK.plate} !important; }
  .pt-link { color: ${DARK.text} !important; }
  .pt-rule { border-top-color: ${DARK.rule} !important; }
}
</style>
<!--[if mso]>
<style>h1, p, td, a, strong { font-family: 'Segoe UI', Arial, sans-serif !important; }</style>
<![endif]-->
</head>
<body class="pt-page" style="margin:0;padding:0;background-color:${LIGHT.page};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">A one-time link to choose a new password. It stops working after ${RESET_TTL_MINUTES} minutes.</div>
<table role="presentation" class="pt-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${LIGHT.page}" style="width:100%;background-color:${LIGHT.page};">
<tr>
<td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr>
<td class="pt-gutter" bgcolor="${LIGHT.brand}" style="padding:18px 28px;background-color:${LIGHT.brand};border-bottom:4px solid ${LIGHT.band};border-radius:14px 14px 0 0;font-family:${SIGN};font-size:24px;line-height:28px;font-weight:800;letter-spacing:-0.3px;color:${ON_BRAND};">PoGo TXK</td>
</tr>
<tr>
<td class="pt-panel pt-gutter" bgcolor="${LIGHT.panel}" style="padding:32px 28px;background-color:${LIGHT.panel};border-radius:0 0 14px 14px;">
<h1 class="pt-text" style="margin:0 0 20px 0;font-family:${SIGN};font-size:26px;line-height:31px;font-weight:800;letter-spacing:-0.4px;color:${LIGHT.text};">Reset your admin password</h1>
<p class="pt-text" style="margin:0 0 16px 0;${BODY}color:${LIGHT.text};">${asked}</p>
<p class="pt-text" style="margin:0 0 24px 0;${BODY}color:${LIGHT.text};">This is for the admin account <strong>${name}</strong>. ${either}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
<tr>
<td align="center" bgcolor="${LIGHT.brand}" style="background-color:${LIGHT.brand};border-radius:8px;mso-padding-alt:14px 24px;">
<a href="${href}" target="_blank" style="display:inline-block;padding:14px 24px;font-family:${READ};font-size:16px;line-height:20px;font-weight:700;color:${ON_BRAND};text-decoration:none;border-radius:8px;">Choose a new password</a>
</td>
</tr>
</table>
<p class="pt-muted" style="margin:0 0 8px 0;${BODY}color:${LIGHT.muted};">If the button does not work, copy this link into your browser:</p>
<p class="pt-plate pt-text" style="margin:0 0 24px 0;padding:12px 14px;background-color:${LIGHT.plate};border-radius:8px;font-family:${MONO};font-size:16px;line-height:24px;color:${LIGHT.text};word-break:break-all;overflow-wrap:anywhere;"><a class="pt-link" href="${href}" target="_blank" style="color:${LIGHT.text};text-decoration:underline;">${href}</a></p>
<p class="pt-text" style="margin:0;${BODY}color:${LIGHT.text};">${once} ${everywhere}</p>
<p class="pt-text pt-rule" style="margin:24px 0 0 0;padding-top:20px;border-top:1px solid ${LIGHT.rule};${BODY}color:${LIGHT.text};">${ignore}</p>
</td>
</tr>
<tr>
<td class="pt-muted pt-gutter" style="padding:20px 28px 0 28px;${BODY}color:${LIGHT.muted};">Sent by PoGo TXK because someone asked to reset an admin password on the site.</td>
</tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td>
</tr>
</table>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ public */

/**
 * The whole message. Throws on a link that is not an absolute http(s) URL and
 * on a control character in either value — see the header for why a throw is
 * the safe answer here.
 */
export function resetMessage({ link, username }: ResetMailInput): ResetMail {
  const safeLink = checkedLink(link);
  const safeName = plainValue('username', username);

  return {
    subject: RESET_SUBJECT,
    text: textPart(safeLink, safeName),
    html: htmlPart(safeLink, safeName),
  };
}
