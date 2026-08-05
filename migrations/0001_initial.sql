-- PoGo TXK — initial schema
--
-- Conventions:
--   * Timestamps are ISO-8601 UTC TEXT ("2026-08-05T19:00:00Z"). They sort
--     lexicographically, compare correctly, and stay readable in `d1 execute`.
--   * Tables are created in dependency order so foreign keys resolve cleanly.
--   * Enum-ish columns use CHECK constraints rather than lookup tables — the
--     value sets are small, stable, and read better inline.

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  discord_id    TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  global_name   TEXT,
  avatar_hash   TEXT,

  -- Pokémon GO profile. All optional — members fill in what they want.
  team          TEXT CHECK (team IN ('valor', 'mystic', 'instinct')),
  trainer_code  TEXT,
  trainer_level INTEGER CHECK (trainer_level BETWEEN 1 AND 80),
  trainer_name  TEXT,

  -- Mirrored from Discord guild roles on each login. `guest` means the account
  -- authenticated but is not in the guild.
  role          TEXT NOT NULL DEFAULT 'guest'
                CHECK (role IN ('guest', 'member', 'ambassador', 'admin')),

  is_banned     INTEGER NOT NULL DEFAULT 0 CHECK (is_banned IN (0, 1)),
  ban_reason    TEXT,

  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_seen_at  TEXT
);

CREATE INDEX idx_users_role ON users (role) WHERE is_banned = 0;

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,             -- opaque random token
  user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at      TEXT NOT NULL,
  user_agent_hash TEXT,                          -- coarse hijack signal, not PII
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Geography
-- ---------------------------------------------------------------------------

-- The expansion seam. Spring Lake Park is the only zone today; adding Bringle
-- Lake or downtown later is an admin action, not a migration.
CREATE TABLE zones (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  blurb        TEXT,
  center_lat   REAL NOT NULL,
  center_lng   REAL NOT NULL,
  default_zoom INTEGER NOT NULL DEFAULT 16,
  min_zoom     INTEGER,
  max_zoom     INTEGER,
  bounds_json  TEXT,                             -- [[swLat,swLng],[neLat,neLng]]
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Exactly one default zone.
CREATE UNIQUE INDEX idx_zones_single_default ON zones (is_default) WHERE is_default = 1;

-- ---------------------------------------------------------------------------
-- Media
-- ---------------------------------------------------------------------------

-- Originals live in R2 under `r2_key`; sizes are derived at the edge by the
-- Images binding. Attribution columns are first-class because the Texarkana
-- Gazette press photos carry a byline and article link we are obliged to keep.
CREATE TABLE media (
  id           INTEGER PRIMARY KEY,
  r2_key       TEXT NOT NULL UNIQUE,
  mime         TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  bytes        INTEGER,

  alt          TEXT,
  caption      TEXT,
  credit       TEXT,
  source_title TEXT,
  source_date  TEXT,
  source_url   TEXT,

  -- 'community_photo' rows are pinned to the map at lat/lng; 'photo' rows hang
  -- off a POI; 'doc' is the code of conduct PDF and friends.
  kind         TEXT NOT NULL DEFAULT 'photo'
               CHECK (kind IN ('photo', 'community_photo', 'doc', 'import')),
  zone_id      INTEGER REFERENCES zones (id) ON DELETE SET NULL,
  lat          REAL,
  lng          REAL,

  uploaded_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_media_kind ON media (kind);
CREATE INDEX idx_media_zone ON media (zone_id);

-- ---------------------------------------------------------------------------
-- Points of interest
-- ---------------------------------------------------------------------------

CREATE TABLE pois (
  id             INTEGER PRIMARY KEY,
  zone_id        INTEGER NOT NULL REFERENCES zones (id) ON DELETE CASCADE,
  slug           TEXT NOT NULL UNIQUE,           -- shareable /map?poi=<slug>
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('pokestop', 'gym', 'powerspot')),
  description    TEXT,
  lat            REAL NOT NULL,
  lng            REAL NOT NULL,

  -- The legacy 'specialgym' type collapses into a gym carrying these flags.
  is_campsite    INTEGER NOT NULL DEFAULT 0 CHECK (is_campsite IN (0, 1)),
  is_meetup_spot INTEGER NOT NULL DEFAULT 0 CHECK (is_meetup_spot IN (0, 1)),
  is_ex_eligible INTEGER NOT NULL DEFAULT 0 CHECK (is_ex_eligible IN (0, 1)),
  sponsor        TEXT,

  status         TEXT NOT NULL DEFAULT 'published'
                 CHECK (status IN ('published', 'pending', 'rejected', 'archived')),

  hero_media_id  INTEGER REFERENCES media (id) ON DELETE SET NULL,
  sort           INTEGER NOT NULL DEFAULT 0,     -- walking order along the raid route

  created_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_pois_zone_type ON pois (zone_id, type) WHERE status = 'published';
CREATE INDEX idx_pois_status ON pois (status);

-- A POI can carry several photos; the legacy site only allowed one.
CREATE TABLE poi_media (
  poi_id   INTEGER NOT NULL REFERENCES pois (id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  sort     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (poi_id, media_id)
);

CREATE INDEX idx_poi_media_media ON poi_media (media_id);

-- Raid route and hotspot polygon live here as GeoJSON instead of being pasted
-- inline into script.js.
CREATE TABLE map_shapes (
  id                 INTEGER PRIMARY KEY,
  zone_id            INTEGER NOT NULL REFERENCES zones (id) ON DELETE CASCADE,
  slug               TEXT NOT NULL,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('route', 'polygon', 'circle')),
  geojson            TEXT NOT NULL,
  style_json         TEXT,
  visible_by_default INTEGER NOT NULL DEFAULT 0 CHECK (visible_by_default IN (0, 1)),
  sort               INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (zone_id, slug)
);

-- Community-reported problems and new-POI proposals, for the moderation queue.
CREATE TABLE poi_reports (
  id            INTEGER PRIMARY KEY,
  poi_id        INTEGER REFERENCES pois (id) ON DELETE CASCADE,  -- NULL = brand new POI
  zone_id       INTEGER REFERENCES zones (id) ON DELETE SET NULL,
  kind          TEXT NOT NULL
                CHECK (kind IN ('new', 'moved', 'removed', 'wrong_info', 'photo', 'other')),
  note          TEXT,
  proposed_json TEXT,                            -- partial POI fields being proposed
  reported_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'accepted', 'rejected')),
  resolved_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_poi_reports_open ON poi_reports (created_at) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Blog
-- ---------------------------------------------------------------------------

CREATE TABLE posts (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  excerpt       TEXT,
  body_md       TEXT NOT NULL DEFAULT '',
  hero_media_id INTEGER REFERENCES media (id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'scheduled', 'published', 'archived')),
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  author_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  published_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Drives the public index: newest published first, pinned on top.
CREATE INDEX idx_posts_published ON posts (published_at DESC) WHERE status = 'published';

CREATE TABLE post_tags (
  post_id INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (post_id, tag)
);

CREATE INDEX idx_post_tags_tag ON post_tags (tag);

-- ---------------------------------------------------------------------------
-- Community meetups
--
-- Distinct from the global Pokémon GO event calendar, which is pulled from
-- ScrapedDuck into KV and never stored here.
-- ---------------------------------------------------------------------------

CREATE TABLE meetups (
  id              INTEGER PRIMARY KEY,
  zone_id         INTEGER REFERENCES zones (id) ON DELETE SET NULL,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  description_md  TEXT,
  starts_at       TEXT NOT NULL,                 -- ISO-8601 UTC
  ends_at         TEXT,
  tz              TEXT NOT NULL DEFAULT 'America/Chicago',
  poi_id          INTEGER REFERENCES pois (id) ON DELETE SET NULL,
  location_text   TEXT,                          -- free text when no POI fits
  campfire_url    TEXT,
  hero_media_id   INTEGER REFERENCES media (id) ON DELETE SET NULL,
  recurrence_rule TEXT,                          -- RFC 5545 RRULE, NULL = one-off
  status          TEXT NOT NULL DEFAULT 'published'
                  CHECK (status IN ('draft', 'published', 'cancelled')),
  created_by      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- "Next meetup" lookup and the ICS feed both scan forward from now.
CREATE INDEX idx_meetups_upcoming ON meetups (starts_at) WHERE status = 'published';

CREATE TABLE meetup_rsvps (
  meetup_id  INTEGER NOT NULL REFERENCES meetups (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'going'
             CHECK (status IN ('going', 'maybe', 'not_going')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (meetup_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Flares — the quick-action payload
-- ---------------------------------------------------------------------------

CREATE TABLE flares (
  id                 INTEGER PRIMARY KEY,
  zone_id            INTEGER REFERENCES zones (id) ON DELETE SET NULL,
  poi_id             INTEGER REFERENCES pois (id) ON DELETE SET NULL,
  kind               TEXT NOT NULL
                     CHECK (kind IN ('raid', 'gym_takedown', 'meetup_here',
                                     'remote_invites', 'trade', 'help')),

  -- Raid specifics. `boss` is a free-text name matched against the ScrapedDuck
  -- boss list at post time; we deliberately do not store their icon URLs.
  boss               TEXT,
  tier               TEXT,
  needed             INTEGER,                    -- for remote_invites

  note               TEXT,
  created_by         INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at         TEXT NOT NULL,
  closed_at          TEXT,
  discord_message_id TEXT                        -- so we can edit/close the embed
);

-- The live board asks "what is open right now" on every socket connect.
CREATE INDEX idx_flares_active ON flares (expires_at) WHERE closed_at IS NULL;
CREATE INDEX idx_flares_poi ON flares (poi_id);

CREATE TABLE flare_rsvps (
  flare_id   INTEGER NOT NULL REFERENCES flares (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'coming'
             CHECK (state IN ('coming', 'here', 'done')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (flare_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Web push
-- ---------------------------------------------------------------------------

CREATE TABLE push_subs (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users (id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  topics_json TEXT NOT NULL DEFAULT '["raid","meetup","post"]',
  user_agent  TEXT,
  failed_at   TEXT,                              -- set on 404/410, pruned later
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_push_subs_user ON push_subs (user_id) WHERE failed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Site settings and audit
-- ---------------------------------------------------------------------------

-- Social links, widget config, hero copy, theme colors. Editable from admin so
-- adding a social account never needs a deploy.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  actor_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  action     TEXT NOT NULL,                      -- 'create' | 'update' | 'delete' | ...
  entity     TEXT NOT NULL,                      -- 'poi' | 'post' | 'meetup' | ...
  entity_id  TEXT,
  diff_json  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_audit_recent ON audit_log (created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log (entity, entity_id);
