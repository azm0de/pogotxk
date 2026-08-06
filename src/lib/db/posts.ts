/**
 * Read model for the blog.
 *
 * The one rule worth stating up front: *what is public is decided by SQL, not
 * by a build step or a cron job*. A post scheduled for Friday at 6 PM is a row
 * with `status = 'scheduled'` and a `published_at` in the future; the predicate
 * below compares that column against the database's own clock on every query,
 * so the post appears the moment the time passes with nothing to deploy, no
 * cache to bust, and no job that can silently stop running.
 */

import { avatarUrl } from '~/lib/auth/types';
import { markdownToText } from '~/lib/markdown';

export type PostStatus = 'draft' | 'scheduled' | 'published' | 'archived';

export interface PostAuthor {
  name: string;
  avatarUrl: string | null;
}

export interface PostHero {
  /** R2 key; the browser fetches it from `/media/<key>`. */
  key: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  credit: string | null;
}

export interface PostSummary {
  id: number;
  slug: string;
  title: string;
  /** Author-written when set, otherwise derived from the opening of the body. */
  excerpt: string;
  status: PostStatus;
  pinned: boolean;
  publishedAt: string | null;
  updatedAt: string;
  author: PostAuthor | null;
  hero: PostHero | null;
  tags: string[];
}

export interface PostDetail extends PostSummary {
  bodyMd: string;
  createdAt: string;
}

/** Shape the admin console works in — every row, no visibility filtering. */
export interface AdminPost {
  id: number;
  slug: string;
  title: string;
  excerpt: string | null;
  bodyMd: string;
  status: PostStatus;
  pinned: boolean;
  heroMediaId: number | null;
  heroKey: string | null;
  publishedAt: string | null;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

/**
 * SQLite evaluates `'now'` per statement, in UTC, in the same
 * `YYYY-MM-DDTHH:MM:SSZ` shape the schema stores — so a plain string compare is
 * also a chronological one. Kept as one constant because the index page, the
 * post page and the RSS feed must never disagree about what is public.
 */
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

const VISIBLE = `(
  (p.status = 'published' AND (p.published_at IS NULL OR p.published_at <= ${NOW}))
  OR (p.status = 'scheduled' AND p.published_at IS NOT NULL AND p.published_at <= ${NOW})
)`;

/**
 * Tags as a comma-joined string. The inner ORDER BY subquery is what makes the
 * order stable — `group_concat` gives no ordering guarantee on its own, and
 * tags are normalised to `[a-z0-9-]` so a comma can never appear inside one.
 */
const TAGS_SQL = `(
  SELECT group_concat(tag) FROM (SELECT tag FROM post_tags WHERE post_id = p.id ORDER BY tag)
) AS tags`;

const AUTHOR_JOIN = 'LEFT JOIN users u ON u.id = p.author_id';
const HERO_JOIN = 'LEFT JOIN media m ON m.id = p.hero_media_id';

interface PostRow {
  id: number;
  slug: string;
  title: string;
  excerpt: string | null;
  status: PostStatus;
  pinned: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  body_md?: string;
  body_head?: string;
  r2_key: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
  credit: string | null;
  global_name: string | null;
  username: string | null;
  discord_id: string | null;
  avatar_hash: string | null;
  tags: string | null;
}

function splitTags(raw: string | null): string[] {
  return raw ? raw.split(',').filter(Boolean) : [];
}

function toSummary(row: PostRow): PostSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt?.trim() || markdownToText(row.body_head ?? row.body_md ?? '', 180),
    status: row.status,
    pinned: row.pinned === 1,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    author: row.username
      ? {
          name: row.global_name ?? row.username,
          avatarUrl: row.discord_id ? avatarUrl(row.discord_id, row.avatar_hash) : null,
        }
      : null,
    hero: row.r2_key
      ? {
          key: row.r2_key,
          alt: row.alt,
          width: row.width,
          height: row.height,
          credit: row.credit,
        }
      : null,
    tags: splitTags(row.tags),
  };
}

function toDetail(row: PostRow): PostDetail {
  return { ...toSummary(row), bodyMd: row.body_md ?? '', createdAt: row.created_at };
}

const SUMMARY_COLUMNS = `p.id, p.slug, p.title, p.excerpt, p.status, p.pinned,
        p.published_at, p.created_at, p.updated_at,
        substr(p.body_md, 1, 500) AS body_head,
        m.r2_key, m.alt, m.width, m.height, m.credit,
        u.global_name, u.username, u.discord_id, u.avatar_hash,
        ${TAGS_SQL}`;

/**
 * Pinned first, then newest. `published_at` falls back to `created_at` so a row
 * that somehow reached `published` without a timestamp still sorts sensibly
 * instead of sinking to the bottom of the list forever.
 */
const PUBLIC_ORDER = 'ORDER BY p.pinned DESC, COALESCE(p.published_at, p.created_at) DESC, p.id DESC';

export interface ListOptions {
  limit?: number;
  offset?: number;
  /** Restrict to one tag, as used by /blog?tag=raids. */
  tag?: string | null;
}

export async function listPublishedPosts(
  db: D1Database,
  { limit = 12, offset = 0, tag = null }: ListOptions = {},
): Promise<{ posts: PostSummary[]; total: number }> {
  const tagFilter = `(?1 IS NULL OR EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND t.tag = ?1))`;

  const [listRes, countRes] = await db.batch<never>([
    db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}
           FROM posts p ${HERO_JOIN} ${AUTHOR_JOIN}
          WHERE ${VISIBLE} AND ${tagFilter}
          ${PUBLIC_ORDER}
          LIMIT ?2 OFFSET ?3`,
      )
      .bind(tag, limit, offset),
    db
      .prepare(`SELECT COUNT(*) AS n FROM posts p WHERE ${VISIBLE} AND ${tagFilter}`)
      .bind(tag),
  ]);

  return {
    posts: (listRes.results as unknown as PostRow[]).map(toSummary),
    total: ((countRes.results as unknown as { n: number }[])[0]?.n ?? 0),
  };
}

export async function getPublishedPost(db: D1Database, slug: string): Promise<PostDetail | null> {
  const row = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}, p.body_md
         FROM posts p ${HERO_JOIN} ${AUTHOR_JOIN}
        WHERE p.slug = ?1 AND ${VISIBLE}`,
    )
    .bind(slug)
    .first<PostRow>();

  return row ? toDetail(row) : null;
}

export interface PostLink {
  slug: string;
  title: string;
}

/**
 * Previous/next links for the bottom of a post. Ordered by publication date
 * rather than id so a back-dated import lands where a reader expects it.
 *
 * Both halves compare the (date, id) pair rather than the date alone. Times are
 * stored to the second, so ties are ordinary — two posts scheduled for the same
 * 6 PM slot get byte-identical stamps. Comparing dates alone, a plain `>=`/`<=`
 * matches the tied sibling on *both* sides, and the reader gets the same post
 * offered as Newer and as Older. The id tiebreak runs the same direction as
 * `PUBLIC_ORDER` (higher id reads as newer), so this nav and the index agree.
 */
export async function getPostNeighbours(
  db: D1Database,
  post: Pick<PostDetail, 'id' | 'publishedAt' | 'createdAt'>,
): Promise<{ newer: PostLink | null; older: PostLink | null }> {
  const at = post.publishedAt ?? post.createdAt;
  const AT = 'COALESCE(p.published_at, p.created_at)';

  const [newerRes, olderRes] = await db.batch<never>([
    db
      .prepare(
        `SELECT p.slug, p.title FROM posts p
          WHERE ${VISIBLE}
            AND (${AT} > ?1 OR (${AT} = ?1 AND p.id > ?2))
          ORDER BY ${AT} ASC, p.id ASC LIMIT 1`,
      )
      .bind(at, post.id),
    db
      .prepare(
        `SELECT p.slug, p.title FROM posts p
          WHERE ${VISIBLE}
            AND (${AT} < ?1 OR (${AT} = ?1 AND p.id < ?2))
          ORDER BY ${AT} DESC, p.id DESC LIMIT 1`,
      )
      .bind(at, post.id),
  ]);

  const first = (res: D1Result): PostLink | null =>
    (res.results as unknown as PostLink[])[0] ?? null;

  return { newer: first(newerRes), older: first(olderRes) };
}

/** Tag cloud for the index, counting only posts a reader can actually open. */
/**
 * Cap on the tag cloud. Every distinct tag ever used renders as a chip on
 * /blog, and at 12 tags per post across a few hundred posts that is a wall
 * rather than a filter. Ordered by use, so the cap drops the long tail.
 */
const TAG_CLOUD_LIMIT = 24;

export async function listPublicTags(db: D1Database): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .prepare(
      `SELECT t.tag, COUNT(*) AS count
         FROM post_tags t JOIN posts p ON p.id = t.post_id
        WHERE ${VISIBLE}
        GROUP BY t.tag
        ORDER BY count DESC, t.tag
        LIMIT ${TAG_CLOUD_LIMIT}`,
    )
    .all<{ tag: string; count: number }>();

  return rows.results;
}

/** Full bodies, for the RSS feed's `content:encoded`. */
export async function listPostsForFeed(db: D1Database, limit = 20): Promise<PostDetail[]> {
  const rows = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}, p.body_md
         FROM posts p ${HERO_JOIN} ${AUTHOR_JOIN}
        WHERE ${VISIBLE}
        ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC
        LIMIT ?1`,
    )
    .bind(limit)
    .all<PostRow>();

  return rows.results.map(toDetail);
}

/* ------------------------------------------------------------------ admin -- */

interface AdminRow {
  id: number;
  slug: string;
  title: string;
  excerpt: string | null;
  /** Absent on list rows — only the detail query selects it. */
  body_md?: string;
  status: PostStatus;
  pinned: number;
  hero_media_id: number | null;
  hero_key: string | null;
  published_at: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
  tags: string | null;
}

/** Everything except the body — see ADMIN_COLUMNS. */
const ADMIN_LIST_COLUMNS = `p.id, p.slug, p.title, p.excerpt, p.status, p.pinned,
        p.hero_media_id, m.r2_key AS hero_key, p.published_at,
        COALESCE(u.global_name, u.username) AS author_name,
        p.created_at, p.updated_at, ${TAGS_SQL}`;

/**
 * The detail query, which is the only one that pulls the body.
 *
 * The list above deliberately omits `body_md`: selecting every post body to
 * render a list of titles is a multi-megabyte response by the time a community
 * has a year of posts, and the admin editor fetches it on mount.
 */
const ADMIN_COLUMNS = `p.id, p.slug, p.title, p.excerpt, p.body_md, p.status, p.pinned,
        p.hero_media_id, m.r2_key AS hero_key, p.published_at,
        COALESCE(u.global_name, u.username) AS author_name,
        p.created_at, p.updated_at, ${TAGS_SQL}`;

/** Generous for a community blog, and bounded. */
const ADMIN_LIST_LIMIT = 200;

function toAdmin(row: AdminRow): AdminPost {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    // Absent on list rows, which do not select it.
    bodyMd: row.body_md ?? '',
    status: row.status,
    pinned: row.pinned === 1,
    heroMediaId: row.hero_media_id,
    heroKey: row.hero_key,
    publishedAt: row.published_at,
    authorName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: splitTags(row.tags),
  };
}

export async function listPostsForAdmin(
  db: D1Database,
  status?: string | null,
): Promise<AdminPost[]> {
  const rows = await db
    .prepare(
      `SELECT ${ADMIN_LIST_COLUMNS}
         FROM posts p ${HERO_JOIN} ${AUTHOR_JOIN}
        WHERE (?1 IS NULL OR p.status = ?1)
        ORDER BY p.pinned DESC, COALESCE(p.published_at, p.updated_at) DESC, p.id DESC
        LIMIT ${ADMIN_LIST_LIMIT}`,
    )
    .bind(status ?? null)
    .all<AdminRow>();

  return rows.results.map(toAdmin);
}

export async function getPostForAdmin(db: D1Database, id: number): Promise<AdminPost | null> {
  const row = await db
    .prepare(`SELECT ${ADMIN_COLUMNS} FROM posts p ${HERO_JOIN} ${AUTHOR_JOIN} WHERE p.id = ?1`)
    .bind(id)
    .first<AdminRow>();

  return row ? toAdmin(row) : null;
}

/**
 * Tags are slugified so `Raid Hour`, `raid-hour` and `Raid  hour` all land on
 * the same row — an author typing a tag from memory should not fork the
 * taxonomy. Commas are impossible by construction, which is what lets the read
 * queries above join them into one string.
 */
export function normalizeTag(raw: string): string {
  return (
    raw
      .normalize('NFKD')
      // Drop the combining marks NFKD just separated out. Without this a tag
      // like "Pokemon" spelled with an accent normalises to "poke-mon" on the
      // server while the client's slugify produces "pokemon", so ?tag= links
      // built by the UI match nothing.
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
  );
}

/**
 * Sorted, because the read queries above order tags alphabetically — a write
 * response that echoed insertion order would disagree with the very next read.
 */
export function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of raw) {
    const normalized = normalizeTag(tag);
    if (normalized) seen.add(normalized);
  }
  return [...seen].sort().slice(0, 12);
}

/**
 * Replace a post's tags wholesale. Delete-then-insert rather than a diff: the
 * set is tiny, and a diff would need three statements to save one.
 */
export async function replacePostTags(
  db: D1Database,
  postId: number,
  tags: string[],
): Promise<string[]> {
  const normalized = normalizeTags(tags);
  const statements = [db.prepare('DELETE FROM post_tags WHERE post_id = ?1').bind(postId)];

  for (const tag of normalized) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?1, ?2)')
        .bind(postId, tag),
    );
  }

  await db.batch(statements);
  return normalized;
}
