-- Self-service password reset for the admin door.
--
-- Until now the answer to "I have lost the admin password" was that there is no
-- answer. `scripts/set-admin-password.ts` says so out loud in two places, and
-- `src/lib/auth/lockout.ts` caps the lockout at an hour precisely because the
-- person behind that door has nobody to ask and nowhere else to go: an admin is
-- a standalone identity under a synthetic `admin:<name>` id, with no Discord
-- account behind it. Losing the password meant losing the account, and the only
-- recovery was somebody with `wrangler` access running the setter against
-- production.
--
-- That is a real single point of failure and it is the one this repository has
-- spent two migrations removing elsewhere. So: a reset link, mailed to an
-- address the admin proved they hold.
--
-- WHAT THIS CHANGES ABOUT THE THREAT MODEL, STATED PLAINLY
--
-- The admin door used to depend on exactly two things: D1, and the password in
-- somebody's head or password manager. It now also depends on **an email
-- provider and on the admin's mailbox being secure**, because anyone who can
-- read that mailbox can take the account. That is a genuine widening — the
-- door is now as strong as the weaker of the password and the mailbox, not as
-- strong as the password — and it is the deliberate trade: an account with no
-- recovery path is one forgotten passphrase away from being gone, and a
-- mailbox is a thing an admin already protects. `email` is nullable, so an
-- admin who would rather keep the narrower model simply has no address on file
-- and no reset is possible for them. Nothing forces one.
--
-- WHY THE TOKEN TABLE MIRRORS `sessions`
--
-- `admin_password_resets.id` is the **SHA-256 of the token**, hex, exactly as
-- `sessions.id` is the SHA-256 of the cookie value. The token itself is never
-- stored anywhere. That is not symmetry for its own sake: a reset token is a
-- bearer credential that mints a password, so a leaked database dump that
-- yielded usable reset links would be worse than one that yielded usable
-- sessions. Reusing the existing idiom — `randomToken()` and `sha256()` from
-- `src/lib/auth/session.ts` — also means there is exactly one hashing scheme
-- for bearer tokens in this repo rather than two that can drift.
--
-- WHY THERE IS NO `email_sent_at`, AND WHAT `created_at` IS DOING
--
-- `created_at` carries the per-account cooldown: a request that finds a recent,
-- unused, unexpired row for that admin issues nothing and sends nothing, so a
-- stranger who knows an admin's address cannot use this endpoint to flood their
-- mailbox. A separate "when did we mail it" column would be a second timestamp
-- meaning almost the same thing, and the one that matters is when the token
-- came into existence — the mail either went out in the same request or the
-- token is useless anyway.
--
-- WHY `used_at` RATHER THAN DELETING THE ROW
--
-- A consumed token is stamped, not removed, so a second click on the same link
-- can be told "this link has already been used" instead of the indistinguishable
-- "this link is not valid". Both are refusals and neither is a security
-- difference — the token is spent either way — but the person holding a spent
-- link is overwhelmingly the legitimate admin double-clicking, and a message
-- that tells them what actually happened is worth one nullable column.
--
-- NOTE FOR WHOEVER READS THIS DURING AN INCIDENT
--
-- A successful reset deletes every *other* outstanding token for that user and
-- **every session for that user**. Not a nicety: a reset is what somebody does
-- after a compromise, and leaving the attacker's session alive would defeat the
-- whole point of it.

-- ---------------------------------------------------------------------------
-- The address
-- ---------------------------------------------------------------------------
--
-- Nullable, because an admin without one is a supported state — see the threat
-- model note above — and because the two rows already in production have no
-- address and must keep working untouched until somebody sets one by hand.
--
-- The `lower()` CHECK is the same one `username` carries, and for the same
-- reason: the lookup binds a lowercased value and compares against the column
-- directly, so the unique index below stays usable. Wrapping the column in
-- `lower()` at query time would force a scan to get the identical answer.
-- `email IS NULL OR ...` is written out rather than relying on SQLite treating
-- a NULL check result as a pass, because that is a rule about three-valued
-- logic and this is a constraint somebody will read in a hurry.
--
-- The length bound is SMTP's path limit. The `@` check is not validation —
-- `normalizeEmail` in `src/lib/notify/email.ts` is — it is the floor that stops
-- an obviously-not-an-address value being written by a hand-typed UPDATE.
ALTER TABLE admin_credentials ADD COLUMN email TEXT
  CHECK (
    email IS NULL
    OR (email = lower(email) AND length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1)
  );

-- UNIQUE as an INDEX rather than as a column constraint, because SQLite's
-- `ALTER TABLE ... ADD COLUMN` refuses a UNIQUE or PRIMARY KEY constraint
-- outright. The guarantee is identical; only the spelling differs.
--
-- Partial, on `email IS NOT NULL`. SQLite already treats NULLs as distinct in a
-- unique index, so this changes nothing about what is allowed — it states it,
-- so the next reader does not have to remember that rule to know that several
-- admins may have no address. `idx_zones_single_default` is the same device.
--
-- It exists for correctness, not for speed: two admins sharing an address would
-- mean a reset request that cannot name which account it is for. The lookup it
-- also happens to make fast runs at most once per request.
CREATE UNIQUE INDEX idx_admin_credentials_email
  ON admin_credentials (email) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The tokens
-- ---------------------------------------------------------------------------

CREATE TABLE admin_password_resets (
  -- The SHA-256 of the token, hex — never the token. Same scheme, and the same
  -- 64-character shape, as `sessions.id`.
  id         TEXT PRIMARY KEY,

  -- `users`, not `admin_credentials`, so this keys on the same id every session
  -- and every audit row in this schema does. CASCADE because a token that
  -- outlived its account would be a credential with nothing behind it.
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- Thirty minutes out, set by the code rather than by a default: the TTL is a
  -- security decision and it belongs where a test can reach it
  -- (`RESET_TTL_MS` in `src/lib/auth/password-reset.ts`), not in a DDL file
  -- nothing imports.
  expires_at TEXT NOT NULL,

  -- Stamped on use. A spent token is refused, and the stamp is what lets the
  -- refusal say which kind of refusal it is.
  used_at    TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Every query here except the lookup-by-token is "this user's tokens": the
-- cooldown check, the sweep that runs when a newer token is issued, and the
-- sweep that runs when one is consumed. The lookup-by-token uses the primary
-- key. So this is the one index worth having, and it is the reason this table
-- has one where `admin_credentials` deliberately has none — that table holds a
-- handful of rows keyed by the columns it is searched on, and this one
-- accumulates rows keyed by something else.
CREATE INDEX idx_admin_password_resets_user ON admin_password_resets (user_id);

-- NO SWEEP, AND NO CRON TO RUN ONE (vault/Why there is no cron.md).
--
-- Expired rows are cleared the same lazy way lapsed sessions are: issuing a
-- token for a user clears that user's older ones, and consuming one clears the
-- rest. The residue is an expired row for an admin who asked for a reset once
-- and never asked again — at most one per admin, on a table whose whole
-- population is the handful of people who can reach `/admin`. An expired row
-- can never authenticate anything; it is a row, not a risk.
