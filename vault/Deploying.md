---
tags: [runbook]
updated: 2026-08-05
---

# Deploying

**Push to `main`.** Workers Builds picks it up and deploys. No workflow file, no API tokens in
GitHub. A deploy takes 60–90 seconds from push.

Manual, if ever needed: `npm run deploy`.

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
  curl -s -m 10 "$B/" | grep -q "some new string" && echo deployed && break
  sleep 15
done
```

## Health sweep

```bash
B=https://pogotxk.gnomelabz.workers.dev
for p in "" go map live events raids eggs research blog gallery about \
         conduct/ terms/ privacy/ rss.xml calendar/all.ics api/map.json api/flares; do
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
