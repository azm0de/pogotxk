---
tags: [architecture]
updated: 2026-08-05
---

# Architecture Overview

One Cloudflare Worker serves everything: the public site, the admin console, the JSON API,
and the WebSocket endpoint. There is no separate backend.

```
                    ┌─────────────────────────────┐
   browser  ───────▶│   Worker (Astro 7, SSR)     │
   /go PWA  ───────▶│                             │
   Android  ───────▶│  middleware → routes        │
                    └──┬────┬────┬────┬───────────┘
                       │    │    │    │
                    ┌──▼─┐┌─▼──┐┌▼───┐└──▶ Durable Object (LiveBoard)
                    │ D1 ││ R2 ││ KV │       WebSocket fan-out
                    └────┘└────┘└────┘
                     data  media  feed cache
```

## Bindings

| Binding | Product | Holds |
|---|---|---|
| `DB` | D1 `pogotxk-db` | POIs, posts, meetups, users, flares, settings — see [[Data Model]] |
| `MEDIA` | R2 `pogotxk-media` | Photo originals, PDFs |
| `CACHE` | KV `pogotxk-cache` | ScrapedDuck payloads |
| `LIVE` | Durable Object | Flare fan-out — see [[Flares and Realtime]] |

Bindings are reached with `import { env } from 'cloudflare:workers'`.
**Not** `Astro.locals.runtime.env` — that was removed in Astro v6 and throws.

## Request path

1. `src/middleware.ts` resolves the session cookie into `Astro.locals.user`, and guards
   `/admin` and `/api/admin/*`. Static assets and `/media/` skip the lookup entirely.
2. Route handlers read bindings directly.
3. Session expiry slides forward via `waitUntil`, off the response path.

## Frontend shape

Astro pages are server-rendered; interactivity is islands only.

- `MapView.tsx` — Leaflet, the biggest island
- `QuickActions.tsx` — the `/go` screen
- `LiveBoard.tsx` — the flare board
- Admin editors — map, meetups, posts, import

Everything else ships zero JavaScript.

## Cost

Runs inside the free tier. D1 5 GB / 5 M reads, R2 10 GB, Durable Objects 100 k requests/day
with WebSocket hibernation so idle sockets cost nothing.

## See also

[[Data Model]] · [[Routes]] · [[Auth and Roles]] · [[Platform Limits and Traps]]
