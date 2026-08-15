-- poi_reports becomes report-only: a visitor may flag a problem with an
-- existing POI, never propose a new one. POI creation stays admin-only, done
-- straight in the map editor rather than through a moderation queue.
--
-- Drops the 'new' kind (poi_id = NULL, "brand new POI") and makes poi_id
-- required. The table has no UI or API writing to it yet, so this is a plain
-- recreate rather than a data migration.

DROP TABLE IF EXISTS poi_reports;

CREATE TABLE poi_reports (
  id            INTEGER PRIMARY KEY,
  poi_id        INTEGER NOT NULL REFERENCES pois (id) ON DELETE CASCADE,
  zone_id       INTEGER REFERENCES zones (id) ON DELETE SET NULL,
  kind          TEXT NOT NULL
                CHECK (kind IN ('moved', 'removed', 'wrong_info', 'photo', 'other')),
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
