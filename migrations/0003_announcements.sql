-- Announcing a post or a meetup to Discord.
--
-- `announceToDiscord` has existed since 0001's era with no caller: the embed
-- builder was written, tested and then never wired to anything, so publishing
-- a post told nobody. What was missing was not the request — it was the two
-- pieces of state that make sending one safe to do from a read path.
--
--   announce_requested  the author ticked "also announce". Most posts are not
--                       announcements, so this defaults to 0 and nothing is
--                       ever sent for a row that did not ask.
--
--   announced_at        NULL means "still owes Discord a message", non-NULL
--                       means settled — whether that settled as a delivered
--                       embed or as a webhook we can never post to again.
--
-- Two columns rather than one because they answer different questions, and
-- collapsing them loses the difference between "nobody wanted this announced"
-- and "this was announced". It also makes un-announcing impossible to do by
-- accident: clearing the toggle does not clear the stamp, so a post cannot be
-- announced twice by toggling it off and on again.
--
-- `announced_at` is also the concurrency claim, exactly as `discord_closed_at`
-- is for flares (see 0002_flare_discord_close.sql). A sweep sets it BEFORE
-- calling Discord, in the same statement that selects the row, so two
-- overlapping page loads cannot both announce the same post. A retryable
-- failure clears it again.
--
-- Why a sweep at all, when the author is right there at save time: a post
-- scheduled for Friday at 6 PM is not public when it is saved, and this Worker
-- has no cron (vault/Why there is no cron.md). The announcement therefore has
-- to ride a later read, the same trade the flare-closure sweep already makes.

ALTER TABLE posts ADD COLUMN announce_requested INTEGER NOT NULL DEFAULT 0
  CHECK (announce_requested IN (0, 1));
ALTER TABLE posts ADD COLUMN announced_at TEXT;

-- Partial, because the rows that still owe Discord a message are a tiny and
-- short-lived slice: everything settles on the first read after it goes public
-- and stays settled. The sweep runs off the read path and must never scan.
CREATE INDEX idx_posts_announce_pending
  ON posts (published_at)
  WHERE announce_requested = 1 AND announced_at IS NULL;

ALTER TABLE meetups ADD COLUMN announce_requested INTEGER NOT NULL DEFAULT 0
  CHECK (announce_requested IN (0, 1));
ALTER TABLE meetups ADD COLUMN announced_at TEXT;

CREATE INDEX idx_meetups_announce_pending
  ON meetups (starts_at)
  WHERE announce_requested = 1 AND announced_at IS NULL;

-- Everything that already exists predates the feature and must not be
-- announced retroactively: without this, the first read after deploy would
-- post every published post and every meetup ever created into the channel at
-- once. `announce_requested` defaults to 0, so this is belt-and-braces against
-- a future default change — and it is the same "settle the backlog before the
-- sweep can see it" step 0002 took for flares, for the same reason.
UPDATE posts
   SET announced_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE announced_at IS NULL;

UPDATE meetups
   SET announced_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE announced_at IS NULL;
