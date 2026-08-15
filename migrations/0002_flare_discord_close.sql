-- Close a flare's Discord embed when the flare ends.
--
-- `discord_message_id` has been stored since 0001 ("so we can edit/close the
-- embed") but nothing ever read it, so every embed stayed looking live forever
-- — including after the flare was closed or had expired. Trainers were being
-- pointed at raids that were already over.
--
-- The board itself needs no sweep: it evaluates `expires_at` on every read, so
-- a flare drops off the moment it lapses. Discord cannot work that way. An
-- embed is already delivered; something has to go back and edit it. That is the
-- whole reason this column exists.
--
-- `discord_closed_at` is that marker, and it is deliberately a separate column
-- rather than a reuse of `closed_at`:
--
--   * a flare can END (closed or expired) without its embed being edited yet —
--     Discord may be down, rate-limiting, or the flare may predate the webhook
--     being configured at all;
--   * it is also the concurrency claim. A sweep sets it BEFORE calling Discord,
--     in the same statement that selects the row, so two overlapping requests
--     cannot both edit the same message. A retryable failure clears it again.
--
-- So: NULL means "still owes Discord an edit", non-NULL means "settled, leave
-- it alone" — whether that settled as a successful edit or as a message we can
-- never edit again (deleted, or the webhook was rotated).
ALTER TABLE flares ADD COLUMN discord_closed_at TEXT;

-- The sweep runs off the read path, so it must never be a table scan. Partial,
-- because the rows that still owe Discord an edit are a tiny and short-lived
-- slice of the table — everything else settles within minutes and stays settled.
CREATE INDEX idx_flares_discord_pending
  ON flares (expires_at)
  WHERE discord_message_id IS NOT NULL AND discord_closed_at IS NULL;

-- Flares that already ended before this migration ran can never be edited
-- correctly: they are either long gone from anyone's attention or their embed
-- is stale beyond use. Settle them so the sweep starts from a clean slate and
-- does not stampede Discord with a backlog of edits on first deploy.
UPDATE flares
   SET discord_closed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE discord_message_id IS NOT NULL
   AND discord_closed_at IS NULL
   AND (closed_at IS NOT NULL OR expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
