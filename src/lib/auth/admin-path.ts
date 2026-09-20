/**
 * Which paths the admin gate covers.
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
 * visitor through Discord sign-in and then refuses them, for a permission the
 * page never wanted.
 *
 * It is not hypothetical under Astro's Cloudflare adapter. A path with no route
 * still reaches the middleware — `fallbackToAssets` returns nothing for a 404
 * and the app renders the not-found page itself — so the redirect happens even
 * where there is nothing to protect.
 */

/** True for `section` itself and anything nested below it, and nothing else. */
function isUnder(path: string, section: string): boolean {
  return path === section || path.startsWith(`${section}/`);
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
 * The owner's password form, which is the one page under `/admin` a signed-out
 * visitor is meant to reach.
 *
 * It has to be exempt or it cannot do its job. `isAdminPath('/admin/login')` is
 * true — it is under `/admin` like everything else — so without this the gate
 * would send the visitor to `/auth/login`, which is the Discord door they are
 * standing here because they cannot use. The page is the recovery path for the
 * day that door is shut; a recovery path behind the thing it recovers from is
 * no recovery path at all.
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
 * The legacy import endpoints, which carry their own bearer-token guard so a
 * fresh deployment can be seeded before anybody is able to sign in.
 *
 * Deliberately narrower than "under /api/admin": the bypass is the `import-`
 * prefix, and nothing else below the admin API gets to skip the role check.
 */
export function isImportPath(path: string): boolean {
  return path.startsWith('/api/admin/import-');
}
