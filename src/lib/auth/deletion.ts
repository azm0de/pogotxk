/**
 * Account deletion.
 *
 * Anonymises rather than deletes the `users` row, for the same reason
 * privacy.astro already gives for the change log: flares, RSVPs and meetup
 * attendance are community history (`ON DELETE CASCADE` / `SET NULL` all over
 * the schema point at `users.id`), and destroying other people's history to
 * satisfy one person's deletion request is worse than unlinking it from them.
 * A `DELETE FROM users` would either cascade-wipe RSVPs and push subs (fine)
 * or silently orphan flares, posts, meetups and the audit log that still name
 * this id (not fine, and not what a foreign key can express — some columns
 * `SET NULL`, some `CASCADE`, and the mix is deliberate per-table, not
 * something one statement can override).
 *
 * No migration needed: every column this touches is already nullable, and
 * `role` already has a 'guest' in its CHECK list.
 */

/**
 * The values the deletion `UPDATE` writes.
 *
 * `discordId` is deterministic and unique per user id, so it can never collide
 * with a real Discord snowflake (numeric only) or with another deleted user —
 * and it stops `upsertUser`'s `ON CONFLICT (discord_id)` from ever matching
 * this row again. That is what makes deletion irreversible from the outside:
 * the same person signing back in with the same real Discord account gets a
 * brand new row, not this one reactivated.
 *
 * Exported on its own so it can be unit-tested without touching D1.
 */
export function anonymizedIdentity(userId: number): { discordId: string; username: string } {
  return { discordId: `deleted:${userId}`, username: 'Deleted user' };
}

/**
 * Anonymises the account and drops everything that lets it act as one going
 * forward: every session (a plain `UPDATE` does not cascade the way a row
 * `DELETE` would) and every push subscription (nothing should still be able
 * to page a deleted account).
 *
 * Left alone on purpose: `flares.created_by`, `meetups.created_by`,
 * `pois.created_by`, `posts.author_id`, `media.uploaded_by`,
 * `poi_reports.*_by`, `meetup_rsvps`, `flare_rsvps`, `settings.updated_by`,
 * `audit_log.actor_id`. All of them keep pointing at this id — which, after
 * this runs, resolves to "Deleted user" with no Discord identity behind it.
 * That is the same shape as the change log's existing promise: the entry
 * stays, the link to a real person does not.
 *
 * **Explicitly NOT left alone: `admin_credentials`, and `users.role_locked`.**
 * `admin_credentials.user_id` carries `ON DELETE CASCADE`, which reads like it
 * covers this and does not: this function anonymises by `UPDATE` and never
 * `DELETE`s the row, so the cascade never fires. A password credential would
 * survive, still valid, still `role_locked`, now attached to a row reading
 * "Deleted user" at `role = 'guest'` — and `/admin/login` would hand whoever
 * knows that password a session as it, then the lock would hold the role
 * against every correction Discord tried to make. Deleting the credential and
 * clearing the lock is the only thing that makes "this account can no longer
 * act" true through both doors rather than only the Discord one.
 *
 * **And, since 2026-09-22, `admin_password_resets`.** Same trap a third time:
 * an outstanding reset link is a credential that mints a password, and it
 * would have outlived the account it belongs to for up to half an hour. It is
 * removed outside the batch — see the comment at the statement for why that
 * is not an oversight.
 */
export async function deleteAccount(db: D1Database, userId: number): Promise<void> {
  const { discordId, username } = anonymizedIdentity(userId);

  await db.batch([
    db
      .prepare(
        `UPDATE users SET
           discord_id    = ?1,
           username      = ?2,
           global_name   = NULL,
           avatar_hash   = NULL,
           team          = NULL,
           trainer_code  = NULL,
           trainer_level = NULL,
           trainer_name  = NULL,
           role          = 'guest',
           role_locked   = 0,
           updated_at    = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?3`,
      )
      .bind(discordId, username, userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM push_subs WHERE user_id = ?1').bind(userId),
    // Not covered by the foreign key's ON DELETE CASCADE, because nothing here
    // deletes the `users` row for it to cascade from. See the note above.
    db.prepare('DELETE FROM admin_credentials WHERE user_id = ?1').bind(userId),
  ]);

  /*
   * Outstanding password-reset links, which are the same bug as the credential
   * one step along: `admin_password_resets.user_id` carries `ON DELETE
   * CASCADE` from `users`, and nothing here deletes a `users` row, so the
   * cascade never fires. A live link surviving deletion is a link that says
   * "set a password on this account" for an account that has just been
   * destroyed — and the reset it drives would also delete sessions for the id
   * behind it. Dangling either way, and there is no reason to leave it.
   *
   * OUTSIDE THE BATCH ABOVE, DELIBERATELY. Every push to this repository
   * deploys, so there is a window in which this code is live and
   * `0005_admin_password_reset.sql` has not been applied. `db.batch` is one
   * transaction, so a missing table in that list would fail the *whole*
   * deletion — turning a schema that is merely behind into an account deletion
   * that cannot be honoured. Swallowed for the same reason: a table that does
   * not exist has no rows to clean up, so there is nothing this failure could
   * mean that matters.
   */
  try {
    await db.prepare('DELETE FROM admin_password_resets WHERE user_id = ?1').bind(userId).run();
  } catch {
    /* the reset table is not there yet; there is nothing in it to remove */
  }
}
