-- A second door into the admin console, opened with a password.
--
-- Discord OAuth is the only way in today, and it has exactly one path to
-- `admin`. `DISCORD_ROLE_ADMIN` and `DISCORD_ROLE_AMBASSADOR` are not set, but
-- `DISCORD_GUILD_ID` is — so `resolveRole` falls through to `member` for every
-- guild member, and because a guild IS configured, `upsertUser` treats that
-- answer as authoritative and writes it. Promoting someone by hand therefore
-- survives exactly until their next sign-in. The only thing holding the door
-- open is `DISCORD_BOOTSTRAP_ADMIN_ID`, a secret that short-circuits
-- `resolveRole` for one Discord account. Lose that account, lose the secret, or
-- have Discord refuse a login, and there is no way back into `/admin` at all.
--
-- So: a password the owner holds, independent of Discord, of the guild, and of
-- anyone else's service being up. It is a break-glass door, not a second front
-- entrance — nothing links to it and members never see it.
--
-- WHY IT HANGS OFF `users` RATHER THAN STANDING ALONE
--
-- `users.discord_id` is `NOT NULL UNIQUE` and every session in this app resolves
-- through a `users` row: `getSessionUser` joins `sessions` to `users` and reads
-- the role, the ban flag and the profile from there. A standalone credentials
-- table would need its own session shape, its own role source and its own ban
-- check — three more things to keep in step with the Discord path, and three
-- more places for them to disagree. Keying on `user_id` means the password
-- proves *which existing user you are*, and everything after that is the code
-- that already runs for every other sign-in.
--
-- WHY `iterations` LIVES IN THE ROW
--
-- PBKDF2's cost is a moving target: what is comfortable on a Worker's CPU
-- budget today is too cheap in three years. Storing the count the hash was
-- derived with means the constant can be raised without invalidating the
-- existing row — verification uses the row's count, and a successful login
-- re-derives at the new one. It also lets the test suite seed a deliberately
-- cheap row (2000) so twenty tests are not twenty full derivations.
--
-- `algorithm` is a one-value CHECK for the same reason: today there is one
-- scheme, and a row that names something the code cannot compute must be
-- rejected by the database rather than discovered at login.
--
-- NO INDEXES, DELIBERATELY
--
-- This table holds one row — the owner's. Every lookup is either the primary
-- key (`user_id`) or the unique index SQLite already creates for
-- `username UNIQUE`. A third index would cost writes and buy nothing.

CREATE TABLE admin_credentials (
  user_id        INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,

  -- Lowercased at the CHECK rather than at the call site, so the uniqueness the
  -- UNIQUE index enforces is the same uniqueness the login lookup asks for:
  -- `WHERE username = lower(?)` cannot miss a row that differs only in case.
  username       TEXT NOT NULL UNIQUE
                 CHECK (username = lower(username))
                 CHECK (length(username) BETWEEN 3 AND 64),

  algorithm      TEXT NOT NULL DEFAULT 'pbkdf2-sha256'
                 CHECK (algorithm IN ('pbkdf2-sha256')),
  iterations     INTEGER NOT NULL CHECK (iterations >= 10000),
  salt           TEXT NOT NULL,                  -- 16 bytes, unpadded base64url
  hash           TEXT NOT NULL,                  -- 32 bytes, unpadded base64url

  -- Lockout state. `failed_attempts` is the running count and `last_failed_at`
  -- is what lets it decay: this Worker has no cron (vault/Why there is no
  -- cron.md), so a counter older than the window resets on the next attempt
  -- rather than being swept. Same shape as the announcement and flare sweeps.
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    TEXT,
  last_failed_at  TEXT,
  last_success_at TEXT,

  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Pins a role against Discord, for the one account that must not lose it.
--
-- `upsertUser` overwrites `role` from Discord whenever Discord is authoritative,
-- and on this deployment it always is. Without a flag in the row itself, the
-- owner's `admin` would be rewritten to `member` by the next Discord sign-in —
-- the exact failure this whole migration exists to survive, arriving through
-- the other door.
--
-- Adding a NOT NULL column with a DEFAULT to an existing table is legal in
-- SQLite; `0003_announcements.sql` already does it twice.
ALTER TABLE users ADD COLUMN role_locked INTEGER NOT NULL DEFAULT 0
  CHECK (role_locked IN (0, 1));

-- WHAT `role_locked` DELIBERATELY DOES NOT PROTECT: `is_banned`.
--
-- The lock pins the role and nothing else. Banning stays the emergency
-- off-switch, and it stays effective against a locked owner, because
-- `getSessionUser` returns undefined for any row with `is_banned = 1` before it
-- ever looks at `role`. A flag that also survived a ban would be a permanent,
-- un-revocable admin — which is the single-point-of-failure shape this
-- migration is trying to get rid of, not one to add a second copy of.
