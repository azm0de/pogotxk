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
 * The legacy import endpoints, which carry their own bearer-token guard so a
 * fresh deployment can be seeded before anybody is able to sign in.
 *
 * Deliberately narrower than "under /api/admin": the bypass is the `import-`
 * prefix, and nothing else below the admin API gets to skip the role check.
 */
export function isImportPath(path: string): boolean {
  return path.startsWith('/api/admin/import-');
}
