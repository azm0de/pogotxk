---
tags: [runbook]
updated: 2026-08-05
---

# Importing Legacy Data

Pulls every POI, photo, map overlay and the meetup from the old site into this one.
Already run against production — this is for re-syncing or seeding a fresh environment.

## The easy way

`/admin` → **Legacy data import** → one button. Admin-only. It runs both passes and shows
progress. Shown prominently while the map is empty, tucked at the bottom once it is not.

## What it actually does

Two endpoints, because a Worker on the free plan gets **50 outbound requests per invocation**
and there are 72 photos.

| | |
|---|---|
| `POST /api/admin/import-legacy` | Metadata. 3 subrequests: `markers.js`, `script.js`, `meetup.js` |
| `POST /api/admin/import-media?limit=30` | Photos into R2. Call until `remaining` is 0 — about three passes |

Both accept **either** an admin session or `Authorization: Bearer $IMPORT_TOKEN`. The token
exists for a fresh deployment where nobody can sign in yet.

Both are idempotent: metadata upserts, media skips anything already in R2.

## Re-importing over existing data

`?force=1` clears the imported tables first. **Anything added or edited in the admin console is
lost.** The UI asks before doing this.

## Expected result

| | |
|---|---|
| POIs | 104 — 66 stop, 16 gym, 22 power spot |
| Campsite | 24 |
| Meetup spot | 1 — Campsite - Genuine |
| Media | 72 rows, 13,617,092 bytes in R2 |
| POI photo links | 63 |
| Shapes | raid route (133 pts), hotspot (42 pts) |
| Credited photos | 9 |

Verified byte-identical between the curl-driven and button-driven runs, against a wiped D1
**and** R2.

## Dry run

```bash
npm run import:dry-run
```

Parses the live site, asserts every count, writes nothing. Useful for detecting that the old
site changed.

## See also

[[Migration from the Old Site]] · [[Data Model]] · [[Attribution Obligations]]
