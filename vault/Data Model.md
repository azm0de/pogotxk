---
tags: [architecture, database]
updated: 2026-08-05
---

# Data Model

17 tables in D1. Schema lives in `migrations/0001_initial.sql`.

Conventions: timestamps are ISO-8601 UTC `TEXT` (they sort lexicographically and stay readable
in `d1 execute`); enum-ish columns use `CHECK` constraints rather than lookup tables.

## Core

```
zones ──┬── pois ──┬── poi_media ── media
        │          └── poi_reports
        ├── map_shapes          (raid route, hotspot — GeoJSON)
        ├── meetups ── meetup_rsvps
        └── media               (community photos pinned to the map)

users ──┬── sessions
        ├── flares ── flare_rsvps
        ├── push_subs
        └── audit_log
```

## Decisions worth knowing

**`zones` is the expansion seam.** Spring Lake Park is the only one today. Adding Bringle Lake
later is an admin action, not a migration. Exactly one zone can be default, enforced by a partial
unique index:

```sql
CREATE UNIQUE INDEX idx_zones_single_default ON zones (is_default) WHERE is_default = 1;
```

**`pois.type` is a clean three-value enum** — `pokestop | gym | powerspot`. The old site had a
fourth type, `specialgym`, for the meetup location. That collapses into a gym carrying
`is_meetup_spot`. See [[Migration from the Old Site]].

**Attribution columns on `media` are first-class** — `credit`, `source_title`, `source_date`,
`source_url`. Several photos are Texarkana Gazette press photos with a byline and article link
we are obliged to keep. See [[Attribution Obligations]].

**POIs archive rather than delete.** `status = archived` removes them from the public map but
keeps them recoverable. Hard delete exists but is admin-only.

**Sessions store a hash, never the token.** `sessions.id` is the SHA-256 of the cookie value, so
a leaked database dump cannot be replayed as a login. See [[Auth and Roles]].

**`audit_log` stores field-level diffs**, not whole rows, and no-op updates are detected and
skipped rather than logged.

## Current contents (production)

| | |
|---|---|
| POIs | 104 — 66 PokéStop, 16 Gym, 22 Power Spot |
| Campsite POIs | 24 |
| Media | 72 — 63 POI photos, 9 community photos |
| Map shapes | 2 — raid route (133 points), hotspot polygon |

## See also

[[Architecture Overview]] · [[Migration from the Old Site]] · [[Importing Legacy Data]]
