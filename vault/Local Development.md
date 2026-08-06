---
tags: [runbook]
updated: 2026-08-05
---

# Local Development

```bash
npm install
cp .dev.vars.example .dev.vars     # then fill in what you need
npm run db:migrate:local
npm run dev                        # http://localhost:4321
```

Local D1, R2 and KV run through Miniflare. Nothing touches production data, and no Cloudflare
account is needed.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server (daemonises — `npx astro dev stop` to kill) |
| `npm run build` | Production build |
| `npm test` | All six suites — ~244 assertions |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:query "SQL"` | Query local D1 |
| `npm run dev:session` | Mint a local admin session, no Discord needed |
| `npm run gen:vapid` | Generate a VAPID keypair |
| `npm run gen:icons` | Rasterise PWA icons from `public/favicon.svg` |
| `npm run import:dry-run` | Parse the legacy site, assert counts, write nothing |

## Signing in locally

Discord OAuth needs a registered redirect for `http://localhost:4321/auth/callback`. To skip
that entirely:

```bash
npm run dev:session
```

It writes a real `users` + `sessions` row using the same SHA-256-of-token scheme the app uses —
**no bypass code ships**. It prints a cookie to paste into the browser console.

## Test suites

| File | Covers |
|---|---|
| `test-auth.ts` | Role resolution, bootstrap admin, role hierarchy, PKCE vs RFC 7636 |
| `test-time.ts` | Timezone conversion across both DST transitions |
| `test-markdown.ts` | Markdown rendering |
| `test-markdown-urls.ts` | URL allowlist — resolves each emitted URL and asserts the origin |
| `test-ics.ts` | RFC 5545: CRLF, 75-octet folding, escaping, stable UIDs |
| `test-notify.ts` | Discord webhook host allowlist, VAPID config validation |

## Gotchas

> [!warning] `npm run build` kills a running dev server
> They contend over `node_modules/.vite`. If the dev server starts throwing
> "The file does not exist at .../deps_ssr/...", that is why:
> ```bash
> npx astro dev stop && rm -rf node_modules/.vite .astro/.vite && npm run dev
> ```

> [!note] Astro blocks cross-site POSTs without a JSON content type
> Any `fetch` that writes must send `content-type: application/json`, or it gets
> "Cross-site POST form submissions are forbidden".

## See also

[[Deploying]] · [[Configuration]] · [[Importing Legacy Data]]
