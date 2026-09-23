/**
 * Which paths the admin gate covers, and who it lets through.
 *
 * Its own module, free of `astro:middleware` and `cloudflare:workers` imports,
 * for the same reason `next.ts` and `device-payload.ts` are — the decision is
 * the part that can be wrong, and this way a plain test can reach it. The
 * middleware around it is then three lines of plumbing.
 *
 * The rule needs a boundary, which is what this exists to supply.
 * `path.startsWith('/admin')` also matches `/administrators`, `/admin-notes`
 * and anything else beginning with those five letters, so the guard quietly
 * annexes names nobody has written yet. The failure mode is not a leak — it is
 * the opposite, and worse for being invisible: a public page that bounces every
 * visitor to the admin sign-in form, for a permission the page never wanted.
 *
 * It is not hypothetical under Astro's Cloudflare adapter. A path with no route
 * still reaches the middleware — `fallbackToAssets` returns nothing for a 404
 * and the app renders the not-found page itself — so the redirect happens even
 * where there is nothing to protect.
 */

import { hasRole, type SessionUser } from './types';

/** True for `section` itself and anything nested below it, and nothing else. */
function isUnder(path: string, section: string): boolean {
  return path === section || path.startsWith(`${section}/`);
}

/**
 * Who the gate lets in: `ambassador` or better, and nobody else.
 *
 * The one statement of that rule, and every place that needs it asks here —
 * the gate in `src/middleware.ts`, `/admin/login`'s "already through, send them
 * on", and `/api/me.json`'s `canAdmin`, which is what decides whether the
 * account menu offers a link to `/admin`. They have to agree exactly: a menu
 * link to a page the gate then refuses is a link to a bounce, and a sign-in
 * page that disagreed with the gate about who is through would pass a caller
 * back and forth between them. One function makes that agreement structural
 * rather than three literals that happen to match today.
 *
 * `undefined` — signed out, or a session `getSessionUser` refused, a banned
 * account among them — is nobody.
 */
export function canReachAdmin(user: SessionUser | undefined): boolean {
  return hasRole(user, 'ambassador');
}

/**
 * The admin surface: the console's pages and its JSON API.
 *
 * Both halves are listed here rather than only the pages, so the boundary is
 * decided once. They are answered differently — a page redirects, an API route
 * returns a status — but that is the caller's business, not this predicate's.
 */
export function isAdminPath(path: string): boolean {
  return isUnder(path, '/admin') || isUnder(path, '/api/admin');
}

/**
 * The admin password form, which is the one page under `/admin` a signed-out
 * visitor is meant to reach.
 *
 * It has to be exempt or it cannot do its job. `isAdminPath('/admin/login')` is
 * true — it is under `/admin` like everything else — and since 2026-09-23 the
 * gate sends every page request it refuses to `/admin/login?next=…`. So
 * without this the gate would redirect this page to itself, forever. (Before
 * that date the gate sent refusals to `/auth/login`, the Discord door, and the
 * failure would have been a quieter one: a dead end, because an admin account
 * is a standalone identity with no Discord account behind it.) A sign-in page
 * behind the gate it exists to get somebody through is no sign-in page.
 *
 * **Matched exactly, and the exactness is the design.** `isUnder` would carry
 * `/admin/login/anything` out with it; `startsWith` would take `/admin/logins`
 * and `/admin/login-notes` besides. Either turns one chosen hole into an
 * open-ended one, and turns it into an opt-out: a page written under a name
 * that happened to match would ship public, with nothing failing to say so.
 * The narrowness is the same one, and for the same reason, as `isImportPath`
 * below — and the mirror of the `/administrators` reasoning at the top of this
 * file, which is that boundary going the other way.
 *
 * The path is not a secret and is not protecting anything. The repository is
 * public, so every path written in it is public knowledge; an unguessable one
 * was considered and rejected on exactly that ground. The password and the
 * lockout behind this page are the controls, and nothing else may be relaxed on
 * the theory that the URL is hard to find.
 */
export function isAdminLoginPath(path: string): boolean {
  return path === '/admin/login';
}

/**
 * The shape of a reset token in a URL: 64 lowercase hex characters.
 *
 * That is exactly what `randomToken()` produces — 32 random bytes rendered as
 * hex — and it is the same shape a session cookie carries. It lives here
 * rather than beside the token code because it is a **gate** decision: it is
 * what `isAdminResetPath` below uses to decide whether a path is admitted, and
 * the argument for its narrowness belongs next to the other narrowness
 * arguments in this file. `src/lib/auth/password-reset.ts` imports it back, so
 * there is one pattern rather than two that can drift.
 *
 * It says nothing about whether the token is real. 2^256 possibilities is not
 * a thing anybody guesses their way through, but this check has not looked at
 * the database and must not be mistaken for having done so — the page behind
 * it does that, and refuses an unknown, expired or spent token itself.
 */
const RESET_TOKEN = /^[0-9a-f]{64}$/;

export function isResetToken(value: string): boolean {
  return RESET_TOKEN.test(value);
}

/**
 * The password-reset pages: asking for a link, and redeeming one.
 *
 * The second hole in the admin gate, cut for the same reason as the first and
 * with the same discipline. The gate sends a signed-out visitor to the admin
 * sign-in form, and this pair of pages exists precisely for the admin who can
 * no longer get through that form — the one door they have, since an admin is
 * a standalone identity with no Discord account behind it. A recovery page
 * behind the gate it exists to recover access to is no recovery page.
 *
 * **Two shapes, and neither is wider than it has to be.**
 *
 *   `/admin/reset`                  the request form, matched **exactly**, the
 *                                   same equality check `isAdminLoginPath`
 *                                   uses and for the identical reason. It is a
 *                                   second exact match, not a widening of the
 *                                   first, and it is not `isUnder`: `isUnder`
 *                                   would carry `/admin/reset/` and everything
 *                                   below it out of the gate in one go.
 *
 *   `/admin/reset/<64 hex>`         the redemption page. This one cannot be an
 *                                   equality check, because the path is
 *                                   different every time — so it is pinned to
 *                                   the *shape of the thing it must admit*
 *                                   instead, which is as narrow as an equality
 *                                   check in every way that matters. Exactly
 *                                   one segment, exactly 64 characters, only
 *                                   `0-9a-f`. It admits no path anybody would
 *                                   ever write a page at.
 *
 * What stays gated, and it is worth reading the list because each one is a
 * path somebody would reach for: `/admin/reset/` (the trailing-slash form,
 * which `isUnder` would exempt and which redeems nothing), `/admin/resets`,
 * `/admin/reset-notes`, `/admin/reset/<token>/anything`, an uppercase token,
 * and a token of any other length. All of them still bounce a signed-out
 * visitor, which is the correct answer for an unrouted path inside the gate.
 *
 * The cost of the narrowness is honest and small: somebody who clicks a
 * *truncated* link — one a mail client wrapped, say — is redirected to the
 * admin sign-in form rather than told the link is broken. That form links to
 * `/admin/reset`, so the way on is one click away, and it is a confusing
 * minute for one person occasionally, against an exemption that cannot be
 * talked into covering a page nobody has written yet. The trade is the same
 * one `isAdminLoginPath` makes and it goes the same way.
 *
 * As there, the path is not a secret and is not protecting anything: the
 * repository is public. The token's entropy, the thirty-minute expiry and the
 * single use behind this page are the controls.
 */
export function isAdminResetPath(path: string): boolean {
  if (path === '/admin/reset') return true;

  const token = path.startsWith('/admin/reset/') ? path.slice('/admin/reset/'.length) : null;
  return token !== null && isResetToken(token);
}

/**
 * The legacy import endpoints, which carry their own bearer-token guard so a
 * fresh deployment can be seeded before anybody is able to sign in.
 *
 * Deliberately narrower than "under /api/admin": the bypass is the `import-`
 * prefix, and nothing else below the admin API gets to skip the role check.
 */
export function isImportPath(path: string): boolean {
  return path.startsWith('/api/admin/import-');
}
