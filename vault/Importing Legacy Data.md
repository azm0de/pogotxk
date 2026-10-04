---
tags: [runbook]
updated: 2026-10-04
---

# Importing Legacy Data

Pulls every POI, photo, map overlay and the meetup from the old site into this one.
Already run against production — this is for seeding a fresh, **empty** environment. It will not
re-sync a database that already has data in it; see [[#Importing again]].

## The easy way

`/admin` → **Legacy data import** → one button. Admin-only, and meant for a fresh environment
only: the importer is not a tool for editors, and anyone running the live site should leave
it alone. It runs both passes and shows progress. Shown prominently while the map is empty,
tucked at the bottom once it is not.

## What it actually does

Two endpoints, because a Worker on the free plan gets **50 outbound requests per invocation**
and there are 72 photos.

| | |
|---|---|
| `POST /api/admin/import-legacy` | Metadata. 3 subrequests: `markers.js`, `script.js`, `meetup.js` |
| `POST /api/admin/import-media?limit=30` | Photos into R2. Call until `remaining` is 0 — about three passes |

Both accept **either** an admin session or `Authorization: Bearer $IMPORT_TOKEN`. The token is
for scripted runs and for a fresh deployment where nobody has signed in yet. It works for these
two endpoints only; no other admin route accepts it.

> [!important] A `curl` call needs an `Origin` header
> Astro checks the origin of every form-like `POST`, and a bare `curl` sends none, so it is
> answered with a plain-text **403** before the route ever runs. That looks like a wrong token
> and is not. Send the site's own origin, or a JSON content type:
>
> ```bash
> curl -X POST https://<site>/api/admin/import-legacy \
>   -H "Authorization: Bearer $IMPORT_TOKEN" \
>   -H "Origin: https://<site>"
> ```
>
> With either in place a populated database answers **409**, which is the importer working,
> not failing. `import-media` has the same `Origin` requirement.

The media pass is safe to repeat: it skips anything already in R2. The metadata pass is not a
re-sync: it runs against an empty database and refuses (409) once there is data.

## Importing again

`import-legacy` **refuses a database that already holds data** and answers 409. There is no
`?force=1` and the dashboard has no "Clear and re-import" button; both were removed in the
2026-10 admin audit, because the forced path deleted every meetup (and its RSVPs), every
POI (and its reports), every uploaded photo's row and the map shapes in one click, and the
button's warning did not list all of that. See [[Admin Audit 2026-10]] (B-12).

A re-import from scratch is now a **developer task**: delete the rows by SQL first (local
database for practice, production only with a fresh `wrangler d1 export` in hand), clear the
matching objects from R2 if photos are included, then run the import against the empty tables.
Nothing about this is something an editor needs to do.

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
