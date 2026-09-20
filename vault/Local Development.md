---
tags: [runbook]
updated: 2026-09-20
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
| `npm test` | The 16 tsx suites — 638 assertions, no runtime and no network |
| `npm run test:worker` | `astro build && vitest run` — 900 tests inside workerd |
| `npm run test:all` | Both layers, tsx first |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:query "SQL"` | Query local D1 |
| `npm run dev:session` | Mint a local admin session, no Discord needed |
| `npm run set:password` | Set the owner's break-glass password — needs a real console, see below |
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

To exercise the owner password door instead:

```bash
npm run set:password -- --create localowner    # then sign in at /admin/login
```

> [!danger] `set:password` refuses to run outside a real console, and that is the point
> Under Git Bash / mintty, `node` gets a pipe rather than a console: `stdin.isTTY` is
> `undefined`, readline's private `_writeToOutput` override silently does nothing, and **the
> password echoes in plain text** while everything downstream looks like it worked. Echo cannot
> be suppressed on a pipe, so the script stops. Use PowerShell or Windows Terminal, or prefix
> with `winpty`. It writes to local D1 unless given `--remote`, which then demands a typed
> confirmation naming the database and the user.

## Tests

There are two layers, and which one a new test belongs in comes down to a single question:
**does it touch a route, a binding or the middleware?**

- **No — a pure function** → a `scripts/test-*.ts` suite, run by `npm test`. Plain `tsx`, no
  runtime and no network, and a failure prints the one assertion that broke.
- **Yes** → a file under `test/`, run by `npm run test:worker`. Vitest inside workerd, with the
  real D1, R2, KV and Durable Object bindings.

`npm run test:all` runs both, tsx first, because the tsx layer is seconds and needs no build.

### `npm test` — 16 suites, 638 assertions

In the order the chain runs them. The counts are what each suite prints, so a drop is visible.

| File | Covers | ok |
|---|---|---|
| `test-auth.ts` | Role resolution, bootstrap admin, the optional member-role gate, role hierarchy, PKCE against the RFC 7636 vector, the `safeNext` open-redirect guard, authorize prompt, which OAuth errors may be retried, `signOutTarget` | 68 |
| `test-signin-surface.ts` | The intent URL that carries sign-in out of the installed app — malformed, it fails by doing *nothing* when tapped, and only on a phone | 16 |
| `test-device-grant.ts` | Device-grant request bodies, response mapping, the cookie payload, and the `login_required` routing split | 44 |
| `test-owner-password.ts` | PBKDF2 against the RFC known-answer vector, hash/verify round trips, NFC normalisation, every way a corrupt row must answer `false` rather than throw, and the lockout schedule including its decay boundary and its one-hour cap | 79 |
| `test-deletion.ts` | The anonymised `users` values account deletion writes | 7 |
| `test-time.ts` | Timezone conversion across both DST transitions | 18 |
| `test-tags.ts` | Server tag normalisation agrees with the client's slugify | 25 |
| `test-markdown.ts` | Post rendering — the whole XSS boundary for the blog: escaping, heading normalisation, tables | 76 |
| `test-markdown-urls.ts` | URL allowlist — resolves each emitted URL and asserts the origin | 18 |
| `test-events.ts` | The event model: global-event normalisation, the live/ongoing/upcoming/past grouping, attribution, meetup UID stability across a rename or reschedule | 60 |
| `test-discord-events.ts` | The Discord scheduled-event mapping behind "Next meetup" — the status and time filtering that stops someone driving to a cancelled meetup | 51 |
| `test-notify.ts` | Discord webhook host allowlist, VAPID config validation | 40 |
| `test-announce.ts` | The announcement builders, and that the "is this post public" predicate still matches the read model's own | 29 |
| `test-game-format.ts` | The game-data presentation helpers, most of it about degrading on bad upstream data | 55 |
| `test-game-image.ts` | Leek Duck image proxy — nothing may resolve off their CDN | 34 |
| `test-flare-permissions.ts` | The client-side gating agrees with what `PATCH /api/flares/:id` will accept | 18 |

Several of these exist because a specific bug got through — `test-tags.ts`, the URL-origin
assertions in `test-markdown-urls.ts`, and the `safeNext` block in `test-auth.ts` all replaced
or filled gaps left by checks that passed while the thing they were checking was broken. See [[Bugs Worth Remembering]].

> [!note] `dry-run-import.ts` is no longer in the chain
> It fetches `https://pokemontxk.com`, so it failed `npm test` outright when offline and tied
> the suite to a third party's uptime. It still has its own script — `npm run import:dry-run` —
> and that is the right place for it: it exists to check the legacy site, so needing the legacy
> site is the point. See [[Importing Legacy Data]].

### `npm run test:worker` — 25 files, 900 tests

Vitest 4.1 with `@cloudflare/vitest-pool-workers`, running inside workerd.

**Why this layer had to exist.** Every API route but `/api/me.json` reaches
`import { env } from 'cloudflare:workers'` at module scope — 19 of the 22 directly, and
`flares/socket.ts` and `game/[feed].json.ts` through `~/do/LiveBoard` and `~/lib/scrapedduck`.
`src/middleware.ts` does the same. A module-scope import of a runtime-only module cannot be
evaluated by `tsx` at all, so no amount of care makes a route importable from the tsx layer —
the HTTP surface, the authorisation gate, sessions, the Durable Object and the Discord callback
were simply unreachable until something could run *inside* the runtime. That is the whole
reason for the second layer, and it is why the split above is about bindings rather than taste.

| Area | Files | What is pinned |
|---|---|---|
| Safety | `00-safety.test.ts` | That the outbound credentials really are blanked, and that the delivery paths cannot reach Discord even so. Named `00-` so it fails first |
| Admin | `admin/` | Every `/api/admin/*` route × method × caller through `SELF.fetch`, the same handlers called directly with the middleware removed, the import-token hole, and the admin pages' redirect-into-sign-in |
| Auth | `auth/` | The middleware, sessions, `/auth/login`, `/auth/callback`, logout, the device grant, the Android exchange, the state cookie, `admin-path`, account deletion, and the owner password door — byte-identical refusals, the lockout, `role_locked` with its control |
| Flares | `flares/` | POST, RSVP, edit and close, the three-way fan-out, Web Push copy and reach, the LiveBoard Durable Object over real WebSockets, and the Discord close sweep |
| Harness | `helpers/` | The factories themselves, because four suites are built on them |

Read `test/setup.ts` before writing a suite. The isolation model is not the one the older
Cloudflare docs describe: `isolatedStorage` is gone, and `reset()` is
`deleteAllDurableObjects()` underneath, which fights this app's deliberate background writes.
Each test instead starts from tables emptied in one batch, so a straggling `waitUntil` write
lands on an empty table and says nothing.

## Gotchas

> [!danger] The Vitest layer is sandboxed. `wrangler dev` is not.
> `.dev.vars` holds a live `DISCORD_WEBHOOK_URL` for the community's real Discord, and wrangler
> folds that file in as secrets whenever a `configPath` is given — which `vitest.config.ts`
> gives it. The config blanks it again and `test/00-safety.test.ts` proves it blanked, so
> `npm run test:worker` cannot post to Discord. **Browser work against `wrangler dev` gets none
> of that.** Comment the value out yourself first. See [[Bugs Worth Remembering]].

> [!warning] `npm run build` kills a running dev server
> They contend over `node_modules/.vite`. If the dev server starts throwing
> "The file does not exist at .../deps_ssr/...", that is why:
> ```bash
> npx astro dev stop && rm -rf node_modules/.vite .astro/.vite && npm run dev
> ```

> [!warning] Two `astro build` runs at once corrupt each other
> The same contention, one step worse: both empty and refill `dist/` and `node_modules/.vite`,
> so one build deletes a directory the other is still walking. It fails as
> `ENOENT: no such file or directory, stat '…\dist\server\.prerender\prerender-entry.*.mjs'`
> inside Astro's own `removeEmptyDirs` — which reads like a broken filesystem rather than like
> two builds. It is intermittent — roughly one pair in four when measured on 2026-09-19 — so a
> retry usually succeeds, and it reads as flakiness rather than as a cause. One build at a time,
> including the one inside `npm run test:worker`.

> [!note] `astro build` *does* empty `dist/`, so a stale bundle is never the reason
> Written down because the opposite is easy to assume. Verified 2026-09-19 by planting marker
> files in `dist/client/_astro/`, `dist/client/` and `dist/server/`: all three were gone after
> the next build. So `rm -rf dist` changes nothing about the output, and if `wrangler dev`
> appears to serve an old island, the cache to suspect is the **service worker** — it is
> cache-first on `/_astro/`, `/icons/` and `/media/` and it claims every page (see
> [[Bugs Worth Remembering]], where that rule caused a real outage). Clear site data or
> unregister it before concluding a verified fix did not work.

> [!warning] The `LIVE` Durable Object does not exist under `astro dev`
> The class is only appended to the Worker entry by the `exportDurableObjects` Vite plugin in
> `astro.config.mjs`, and that plugin runs during `astro build` and nowhere else. `/live`'s
> WebSocket board therefore needs `npm run build && npm run preview` — `wrangler dev` against a
> built worker — and cannot be exercised from the dev server at all.
>
> It is the same fact that makes `vitest.config.ts` point `main` at `dist/server/entry.mjs`, and
> why `test:worker` builds first. **Never run bare `vitest run` after changing `src/`**: the
> entry is whatever you last built, so a stale one silently tests old code and passes.

> [!note] Astro blocks cross-site POSTs, but only for form-like content types
> Any `fetch` that writes must send `content-type: application/json`, or it gets
> "Cross-site POST form submissions are forbidden".
>
> Worth knowing which way round that is: JSON is not the *protected* shape, it is the shape
> Astro's origin check **skips entirely**. Convenient for a `fetch` caller, a hole for anything
> that accepts credentials — which is why `/api/auth/admin-login` takes form encoding only. See
> [[Platform Limits and Traps]].

> [!note] A test's non-GET request needs an `origin` header
> Astro's CSRF check also compares `Origin` against the request URL and answers **403** when
> they differ. A browser always sends it; `SELF.fetch` never does, so a hand-built POST fails
> before the route runs — and fails in a shape that hides what happened, because that body is
> plain text, `res.json()` throws on it rather than reporting a status, and the whole thing
> reads like an auth failure. `jsonRequest` and `jsonAsUser` in `test/helpers/factories.ts` set
> it for you; use them rather than building a `Request` by hand.

> [!warning] An unconsumed Durable Object response body wedges the rest of the file
> A body left unread on a stub `fetch` pins the object, and `evictAllDurableObjects` in
> `test/setup.ts` then never returns. It surfaces as every *later* test in the file timing out
> in a `beforeEach` that has nothing to do with them — so the test that caused it is the one
> that passed. Consume the body, `await res.text()`, even when the assertion is only on the
> status. A WebSocket left open at the end of a test does exactly the same thing;
> `test/flares/live-board.test.ts` tracks every socket it opens and closes them between tests.

## See also

[[Deploying]] · [[Configuration]] · [[Importing Legacy Data]]
