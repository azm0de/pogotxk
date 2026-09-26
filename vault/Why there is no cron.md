---
tags: [decision]
updated: 2026-09-26
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

## It was not actually gone until 2026-09-26

Everything above was true of the *file*. Cloudflare kept running the trigger anyway, and the
permanent error stream this note warns about ran for seven weeks: 48 exceptions a day, every day,
from the 2026-08-05 schedule.

`wrangler deploy` only sends schedules when `triggers.crons` is set. A missing key means "leave
Cloudflare's copy alone", not "none", so deleting the line changed nothing on the next deploy.
`wrangler.jsonc` now says `"triggers": { "crons": [] }`, which wrangler does send. **The empty
list is load-bearing.** Delete it and nothing breaks today, but the next stray schedule has
nothing to clear it.

`test/scheduled.test.ts` pins both halves: the built entry exports no `scheduled()`, and the
generated `dist/server/wrangler.json` carries `crons: []`. To check what Cloudflare really has,
ask it rather than the file: `GET /accounts/{id}/workers/scripts/pogotxk/schedules`. See
[[Bugs Worth Remembering]].

## Riding the read is the pattern, not the workaround

This is now a theme rather than one decision, and it is worth recognising on sight: **when
something has to happen at a moment nobody is necessarily making a request, it is attached to
the next read of a page that already had to do the work.** Three places do it, and they differ
only in which read they ride and how hot that read is.

| What | Rides | How promptly |
|---|---|---|
| ScrapedDuck feed refresh — `getFeed`, `src/lib/scrapedduck.ts` | Any page showing raids, eggs, research or events | First visitor past the 30-minute freshness window |
| Discord close sweep — `sweepFlareDiscordClosures`, `src/lib/notify/flare-closures.ts` | `GET /api/flares` | Seconds — every open board polls it, and every socket reconnect hits it |
| Announcement sweep — `sweepAnnouncements`, `src/lib/notify/announcements.ts` | The home page read | Cold. A 6 PM post announces on the first load *after* 6 PM |

The shared properties are what make it safe: the work is **idempotent**, it is **bounded** (ten
embeds a pass, three announcements), it runs **off the response path** under `waitUntil`, and
anything that must not happen twice is **claimed inside the selecting statement** so a second
concurrent reader sees no rows.

The shared honesty is that none of it is a scheduler. A flare's embed settles within seconds
because somebody is always looking at the board; a scheduled post waits for a visitor. It is
still sent, and still sent exactly once — but [[Notifications]] is right to say it should not be
sold as a clock. The cache has the matching caveat: `HARD_TTL_S` would expire the KV entry
outright after seven days of zero traffic, leaving the stale-fallback with nothing to fall back
to.

## If it is ever added back

`refreshAllFeeds(env)` is exported from `src/lib/scrapedduck.ts` and has no callers. Wire an
auxiliary worker to it and put the cron on **that** worker.

## See also

[[Platform Limits and Traps]] · [[Architecture Overview]]
