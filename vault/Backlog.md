---
tags: [planning]
updated: 2026-08-05
---

# Backlog

Everything in the original plan is built. This is what is left, roughly by value.

## Blocked on the owner

- [ ] **Turn on notifications** — `npm run gen:vapid`, then add the three VAPID secrets and
      `DISCORD_WEBHOOK_URL`. Code is deployed and tested. See [[Notifications]]
- [ ] **Test the bubble on a real phone**, ideally over Pokémon GO. See [[Android App]]
- [ ] **Rotate the Discord client secret** — it passed through a chat transcript during setup

## Worth doing next

- [ ] **Custom domain.** Point `pokemontxk.com` at the Worker and retire the old site, then set
      `SITE_URL=https://pokemontxk.com` in the Workers Builds environment — that one variable
      moves canonical URLs, RSS and the ICS `SOURCE` field together. The Discord redirect URI
      needs adding separately in the Developer Portal. Until then `site` deliberately names the
      `workers.dev` host, because pointing it at a domain that 404s is exactly what broke every
      subscribe link (see [[Bugs Worth Remembering]])
- [ ] **Announce posts and meetups to Discord.** `announceToDiscord` exists and has no caller —
      wire the "also announce" toggle in the post editor to it
- [ ] **Community POI submissions.** `poi_reports` and the moderation queue exist in the schema;
      no UI yet
- [ ] **KMZ import in admin.** Their source of truth is Google Earth. `lib/kml.ts` was planned
      and never built — upload a KMZ, diff against the database, approve changes

## Known rough edges

- [x] ~~Unbounded admin queries~~ — bounded, and the post list no longer carries bodies
- [x] ~~`--live` contrast below AA~~ — split into `--live` and `--live-text`, both pass
- [x] ~~Live board not announced to screen readers~~ — announces a count on change
- [x] ~~`SEQUENCE` can decrease~~ — pinned for global events, still derived for meetups
- [ ] **Photo carousel** — the API and schema support multiple photos per POI; nothing uploads a
      second one yet, so the UI is unbuilt
- [ ] **`src/lib/scrapedduck.ts` cannot be unit tested.** It imports `cloudflare:workers` at
      module scope, alongside ~10 pure helpers (`raidTierRank`, `relativeTime`, `formatCp`…).
      Splitting the presentation helpers into their own module would make them testable, but it
      rewrites imports across six components — a refactor, not a fix
- [x] ~~Events page uses `Astro.site` in prod~~ — it now always builds calendar links from the
      request origin. The old behaviour shipped six subscribe links that 404'd
- [x] ~~Open redirect via `next=`~~ — `/\host` and tab-smuggled variants are blocked, the
      callback re-validates, and 21 assertions cover it
- [x] ~~Leaving the Discord kept your role~~ — `fetchGuildRoles` now distinguishes
      "not configured" from "not a member"

## Audit still owed

Three of five production auditors reported before the run was stopped on 2026-08-05. Their
findings are fixed and deployed. **Two never reported** — the remaining surfaces have not had an
adversarial read:

- [ ] Admin console and moderation authorisation boundaries
- [ ] Durable Object / live board under concurrency

Worth finishing before the site is announced to the community, given that the three that did run
found a security defect apiece.

## Deliberately not doing

- **iOS Live Activity.** Needs a native app, an Apple Developer account and store review, for a
  strictly worse version of what the web app already does. See
  [[Why iOS cannot have a floating bubble]]
- **A cron.** See [[Why there is no cron]]
- **Anything that reads the game.** See [[Never Touch the Game]]
- **Ads.** Would breach the Leek Duck terms. See [[Attribution Obligations]]

## See also

[[Home]] · [[Bugs Worth Remembering]]
