---
tags: [runbook]
updated: 2026-09-23
---

# Deploying

**Push to `main`.** Workers Builds picks it up and deploys. No API tokens in GitHub, and nothing
in GitHub triggers the deploy. A deploy takes 60–90 seconds from push.

Manual, if ever needed: `npm run deploy`.

**Every other branch uploads a version and deploys nothing.** A push to any branch but `main` runs
the same build and then `npx wrangler versions upload`: the dashboard's **Version command**, under
Settings → Build → Build configuration. That stores a new Worker version without routing any
traffic to it. A pull request still gets its "Workers Builds" check, and production is untouched.

Merging to `main` *is* the release. So additive migrations (`npm run db:migrate:remote`) run
before the merge, not after it.

> [!danger] The Version command said `npx wrangler deploy` until 2026-09-23
> Until then, **every branch push went live**: unmerged, unreviewed, and ahead of any migration it
> needed. That is how production came to run code expecting migration `0004` before `0004` had
> been applied (2026-09-21). If a branch push ever shows up as a new entry in
> `wrangler deployments list`, look at that box first.
>
> Leave the dashboard's "Set up Worker Previews" banner alone unless you mean it. Moving to Worker
> Previews is one-way, and previews need their own variables, secrets and bindings configured.

> [!warning] CI does not gate the deploy
> `.github/workflows/ci.yml` runs typecheck and both test layers on a push to `main` and on every
> pull request. It is a **signal, not a gate**: Workers Builds watches the repository directly and
> starts the moment the push lands, so a deploy and its CI run race each other and the deploy wins.
> A red cross appears next to a commit that is already live.
>
> That is fine for a pull request, which is where the checks actually earn their keep. If you want
> a failing test to genuinely stop a release, the commands have to run *inside* the Workers Builds
> build command, in front of `npm run build`, so a non-zero exit fails the build itself:
>
> ```
> npm ci && npm run cf-typegen && npm run typecheck && npm test && npm run test:worker && npm run build
> ```
>
> The cost is roughly a minute and a half added to every deploy. Untried so far — the trade is
> real and it is a choice, not an oversight.

> [!danger] Know which URL you are testing
> `https://pogotxk.gnomelabz.workers.dev` — **production**, updates on every deploy
> `https://ec3b35ec-pogotxk.gnomelabz.workers.dev` — a **frozen per-version preview**, never updates
>
> Testing the versioned URL and concluding "the deploy is broken" cost real time. If a change
> is not showing up, check the hostname first.

## Verifying a deploy

Edge nodes update over ~30–90 seconds, so the first request after a push can still hit the old
version. Poll for something the new version has rather than checking once:

```bash
B=https://pogotxk.gnomelabz.workers.dev
for i in $(seq 1 20); do
  curl -s -m 10 -H 'Cache-Control: no-cache' "$B/?v=$i" | grep -q "some new string" && echo deployed && break
  sleep 15
done
```

> [!warning] Bust the cache or the check will lie to you
> A verification run on 2026-08-05 reported the *old* subscribe host and an *unblocked* redirect
> payload while the canonical tag on the same deployment already showed the *new* value. Both
> fixes were in fact live; the stale responses were cached. Always send
> `Cache-Control: no-cache` **and** a unique query string before concluding a deploy failed —
> the alternative is re-fixing something that was never broken.

Different edges can disagree for a while, so a single failing check right after a push is not
evidence of anything.

## Health sweep

```bash
B=https://pogotxk.gnomelabz.workers.dev
for p in "" go map live events raids eggs research blog gallery about \
         conduct/ terms/ privacy/ rss.xml api/map.json api/flares; do
  printf '%-20s %s\n' "/$p" "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$B/$p")"
done
```

Expected: all `200`, except `/auth/login` and `/admin` which are `302` when signed out.

WebSocket check — `426` without an upgrade header, `101` with one:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
  "$B/api/flares/socket"
```

If that returns `503`, the Durable Object binding is not live — see [[Flares and Realtime]].

## Trailing slashes

Prerendered pages (`/terms`, `/privacy`, `/conduct`, `/offline`) are served as static assets and
`307` to a trailing slash. Harmless in a browser, but it matters in one place: `Cache.put()`
rejects a redirected response, so the service worker caches `/offline/` **with** the slash. See
[[Bugs Worth Remembering]].

## Migrations

```bash
npm run db:migrate:remote
```

Needs an authenticated wrangler (`wrangler login`). Migrations are tracked in `d1_migrations`,
so re-running is safe.

## See also

[[Configuration]] · [[Local Development]] · [[Platform Limits and Traps]]
