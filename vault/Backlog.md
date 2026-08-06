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

- [ ] **Custom domain.** Point `pokemontxk.com` at the Worker and retire the old site. Redirect
      URIs and the ICS `SOURCE` field both need updating
- [ ] **Announce posts and meetups to Discord.** `announceToDiscord` exists and has no caller —
      wire the "also announce" toggle in the post editor to it
- [ ] **Community POI submissions.** `poi_reports` and the moderation queue exist in the schema;
      no UI yet
- [ ] **KMZ import in admin.** Their source of truth is Google Earth. `lib/kml.ts` was planned
      and never built — upload a KMZ, diff against the database, approve changes

## Known rough edges

- [ ] **Unbounded admin queries.** `listPostsForAdmin` selects full `body_md` with no `LIMIT`,
      and `listPublicTags` has no cap. Fine at current volume, will degrade
- [ ] **`--live` (#e8453c) is ~3.9:1 on white** — below AA for small bold text. Used in several
      components; fixing means touching `global.css`
- [ ] **The live board is not a live region.** Screen reader users get no announcement when a
      flare arrives. Announcing every card would be worse than nothing; a polite "3 flares
      active" summary is probably right
- [ ] **Photo carousel** — the API and schema support multiple photos per POI; nothing uploads a
      second one yet, so the UI is unbuilt
- [ ] **`SEQUENCE` can decrease** in the ICS feed if an event moves earlier. Harmless for
      `METHOD:PUBLISH`, wrong for iTIP

## Deliberately not doing

- **iOS Live Activity.** Needs a native app, an Apple Developer account and store review, for a
  strictly worse version of what the web app already does. See
  [[Why iOS cannot have a floating bubble]]
- **A cron.** See [[Why there is no cron]]
- **Anything that reads the game.** See [[Never Touch the Game]]
- **Ads.** Would breach the Leek Duck terms. See [[Attribution Obligations]]

## See also

[[Home]] · [[Bugs Worth Remembering]]
