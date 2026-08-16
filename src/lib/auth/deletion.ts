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
           updated_at    = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?3`,
      )
      .bind(discordId, username, userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM push_subs WHERE user_id = ?1').bind(userId),
  ]);
}
