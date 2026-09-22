---
tags: [architecture, database]
updated: 2026-09-21
---

# Data Model

18 tables in D1. Schema lives in `migrations/0001_initial.sql`, with later changes in the
numbered migrations beside it.

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
        ├── admin_credentials  (0 or 1 — an admin's password)
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

**`poi_reports` is report-only, not submission.** A visitor may flag that an existing POI moved,
closed, or has wrong info — `poi_id` is `NOT NULL` and every row points at a POI that already
exists. There is no path for a visitor to propose a brand-new POI; that stays admin-only, added
directly in the map editor. An earlier `'new'` kind (`poi_id = NULL`, "brand new POI") was
dropped in migration `0002` before any UI or API ever wrote to the table. See [[Backlog]].

**Sessions store a hash, never the token.** `sessions.id` is the SHA-256 of the cookie value, so
a leaked database dump cannot be replayed as a login. See [[Auth and Roles]].

**`admin_credentials` hangs off `users` rather than standing alone.** One row per admin, keyed
`user_id INTEGER PRIMARY KEY` — so the key is what makes it at most one credential *per user*,
not one row in the table. Production holds two.

It could have been its own identity table and deliberately is not, and that stays true even
though an admin is now a standalone identity with no Discord account behind it. The identity is
standalone; the plumbing is shared. `users.discord_id` is `NOT NULL UNIQUE` and every session in
this app resolves through a `users` row, so a separate table would need its own session shape,
its own role source and its own ban check — three more things to keep in step with the Discord
path. Keying on `user_id` means the password proves *which existing user you are* and nothing
else runs twice. What makes the identity standalone instead is the **value** in `discord_id`: a
synthetic `admin:<name>` that no Discord sign-in can ever match. See [[Auth and Roles]].

The columns worth knowing:

| Column | Why |
|---|---|
| `algorithm` | One-value `CHECK`. A row naming a scheme the code cannot compute is rejected by the database, not discovered at login |
| `iterations` | The cost is **stored per row**, so it can be raised without invalidating the hash — and so the test suite can seed a cheap one. `CHECK (iterations >= 10000)` |
| `salt` / `hash` | Unpadded base64url, 16 and 32 bytes. Plain `TEXT`, so a corrupt value here *is* reachable and `verifyPassword` is written to answer `false` rather than throw |
| `failed_attempts`, `last_failed_at` | The lockout counter, and what lets it decay on the next attempt rather than on a sweep — there is no cron ([[Why there is no cron]]) |
| `username` | `CHECK (username = lower(username))`, so the `UNIQUE` index and the login lookup ask the same question and the index stays usable |

**No indexes on it, deliberately.** One row; every lookup is the primary key or the unique index
SQLite already builds for `username`.

**`users.role_locked` pins a role against Discord.** Added in `0004`. `upsertUser` checks it
*before* it checks whether Discord is authoritative, because SQLite takes the first true branch
and `authoritative` is permanently 1 on this deployment. It deliberately does **not** protect
`is_banned`. See [[Auth and Roles]].

**Account deletion has to name `admin_credentials` explicitly.** The foreign key carries
`ON DELETE CASCADE`, which reads like it covers deletion and does not: `deleteAccount`
anonymises by `UPDATE` and never `DELETE`s the `users` row, so the cascade never fires.

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
