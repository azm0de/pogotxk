---
tags: [decision]
updated: 2026-08-05
---

# Why there is no cron

**Decision:** `wrangler.jsonc` declares no scheduled triggers.

## What happened

A `*/30 * * * *` trigger was declared early, to refresh the ScrapedDuck feed. The handler never
existed. The Astro adapter emits a worker entry exporting only `default` — confirmed, no
`scheduled()` anywhere in `dist`.

Cloudflare would have invoked that trigger and failed with "Handler does not export a
scheduled() function" **every thirty minutes, forever**, into an observability-enabled Worker.

## Why not just add the handler

The adapter offers no hook for one. The supported route is an auxiliary worker via
`auxiliaryWorkers`, which means a second worker, a second entry, and the cron moved onto it.

That is real complexity for a modest benefit, because nothing depends on the cron:

- `getFeed` refreshes lazily on read
- On upstream failure it serves the last good cached copy
- Flare expiry is computed on read, not swept

The only cost of having no cron is that the first visitor after the freshness window waits for
the upstream fetch.

> A permanent error stream is a worse trade than a cold cache.

## If it is ever added back

`refreshAllFeeds(env)` is exported from `src/lib/scrapedduck.ts` and has no callers. Wire an
auxiliary worker to it and put the cron on **that** worker.

## See also

[[Platform Limits and Traps]] · [[Architecture Overview]]
