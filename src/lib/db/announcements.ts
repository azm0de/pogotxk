/**
 * Claiming the posts and meetups that still owe Discord an announcement.
 *
 * The two tables are handled side by side in one file on purpose. They have
 * different visibility rules — a post can be scheduled into the future, a
 * meetup is public the moment it is published — and every previous attempt to
 * express "what is announceable" in two places is how the two halves of a rule
 * like this drift apart. Here the difference is four lines apart and visible.
 *
 * The claim-then-send ordering, and why `announced_at` is written before
 * Discord is called at all, is documented in `0003_announcements.sql` and works
 * exactly as `claimFlaresForDiscordClose` does. Read that first if this looks
 * like it is marking work done before doing it — it is, and deliberately.
 */

/**
 * When a post is publicly readable.
 *
 * Deliberately the same predicate as `VISIBLE` in `db/posts.ts`, because
 * announcing a post the site would still 404 is the one failure this feature
 * can produce that the community actually sees. It is repeated rather than
 * imported because that constant is private to the read model and aliases its
 * table as `p`; the duplication is one line and the test asserts they agree.
 */
export const POST_PUBLIC = `(
  (status = 'published' AND (published_at IS NULL OR published_at <= ?1))
  OR (status = 'scheduled' AND published_at IS NOT NULL AND published_at <= ?1)
)`;

/**
 * A meetup is announceable when it is published — not when it starts.
 *
 * `cancelled` is excluded even though the public list includes it: the feed
 * carries a cancelled meetup so subscribers learn it is off, but posting a
 * fresh embed for one would be announcing an event that is not happening.
 */
export const MEETUP_PUBLIC = `status = 'published'`;

export interface PendingPostAnnouncement {
  id: number;
  slug: string;
  title: string;
  excerpt: string | null;
  body_md: string;
  hero_key: string | null;
}

export interface PendingMeetupAnnouncement {
  id: number;
  title: string;
  description_md: string | null;
  starts_at: string;
  ends_at: string | null;
  tz: string;
  poi_name: string | null;
  location_text: string | null;
  hero_key: string | null;
}

/**
 * Take ownership of posts that asked to be announced and are now public.
 *
 * `onlyId` narrows the claim to a single row so the save that requested the
 * announcement can settle it immediately, through the same statement the sweep
 * uses — a save racing a sweep therefore cannot produce two embeds.
 */
export async function claimPostAnnouncements(
  db: D1Database,
  now: string,
  limit: number,
  onlyId?: number,
): Promise<PendingPostAnnouncement[]> {
  const res = await db
    .prepare(
      `UPDATE posts
          SET announced_at = ?1
        WHERE id IN (
          SELECT id FROM posts
           WHERE announce_requested = 1
             AND announced_at IS NULL
             AND ${POST_PUBLIC}
             AND (?2 IS NULL OR id = ?2)
           ORDER BY published_at
           LIMIT ?3)
      RETURNING id, slug, title, excerpt, body_md,
                (SELECT r2_key FROM media WHERE media.id = posts.hero_media_id) AS hero_key`,
    )
    .bind(now, onlyId ?? null, limit)
    .all<PendingPostAnnouncement>();
  return res.results ?? [];
}

export async function claimMeetupAnnouncements(
  db: D1Database,
  now: string,
  limit: number,
  onlyId?: number,
): Promise<PendingMeetupAnnouncement[]> {
  const res = await db
    .prepare(
      `UPDATE meetups
          SET announced_at = ?1
        WHERE id IN (
          SELECT id FROM meetups
           WHERE announce_requested = 1
             AND announced_at IS NULL
             AND ${MEETUP_PUBLIC}
             AND (?2 IS NULL OR id = ?2)
           ORDER BY starts_at
           LIMIT ?3)
      RETURNING id, title, description_md, starts_at, ends_at, tz, location_text,
                (SELECT name FROM pois WHERE pois.id = meetups.poi_id) AS poi_name,
                (SELECT r2_key FROM media WHERE media.id = meetups.hero_media_id) AS hero_key`,
    )
    .bind(now, onlyId ?? null, limit)
    .all<PendingMeetupAnnouncement>();
  return res.results ?? [];
}

/**
 * Hand a claimed row back so a later pass retries it.
 *
 * Only for failures that could plausibly succeed later. A webhook that is
 * genuinely gone stays settled, or every read from now on re-attempts it.
 */
export async function releaseAnnouncement(
  db: D1Database,
  table: 'posts' | 'meetups',
  id: number,
): Promise<void> {
  // `table` is a closed union rather than a parameter, so this cannot become an
  // injection point no matter what a caller passes.
  const sql =
    table === 'posts'
      ? 'UPDATE posts SET announced_at = NULL WHERE id = ?1'
      : 'UPDATE meetups SET announced_at = NULL WHERE id = ?1';
  await db.prepare(sql).bind(id).run();
}
