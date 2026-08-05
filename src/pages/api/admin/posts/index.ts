/**
 * Post listing and creation.
 *
 * Publication times come in as wall-clock strings plus a zone, the same
 * contract the meetup routes use, so "Friday 6 PM" means 6 PM in Texarkana on
 * both sides of the CST/CDT switch. What is stored is always a UTC instant.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ApiError, handler, json, readJson, requireRole } from '~/lib/api';
import { recordAudit } from '~/lib/db/audit';
import { listPostsForAdmin, replacePostTags } from '~/lib/db/posts';
import { uniqueSlugInTable } from '~/lib/slug';
import { DEFAULT_TZ, zonedToUtc } from '~/lib/time';

export const prerender = false;

const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export const postInput = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  /** Optional override; otherwise derived from the title. */
  slug: z.string().trim().max(200).optional(),
  excerpt: z.string().trim().max(400).nullable().optional(),
  bodyMd: z.string().max(100_000).optional(),
  status: z.enum(['draft', 'scheduled', 'published', 'archived']).optional(),
  pinned: z.boolean().optional(),
  tags: z.array(z.string().trim().max(60)).max(12).optional(),
  heroMediaId: z.number().int().positive().nullable().optional(),
  /** Wall-clock, as produced by <input type="datetime-local">. */
  publishedAtLocal: z
    .string()
    .regex(LOCAL_DATETIME, 'Expected YYYY-MM-DDTHH:MM')
    .nullable()
    .optional(),
  tz: z.string().min(1).optional(),
});

export type PostInput = z.infer<typeof postInput>;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Work out the stored instant.
 *
 * A `scheduled` post whose time has already passed is deliberately *not* an
 * error: that is the normal end state of every scheduled post, and rejecting
 * it would mean an author could no longer fix a typo in a post that went live
 * an hour ago. The read model treats "scheduled and due" as public, so the two
 * halves agree.
 */
export function resolvePublishedAt(
  input: Pick<PostInput, 'status' | 'publishedAtLocal' | 'tz'>,
  existing: string | null,
): string | null {
  if (input.publishedAtLocal) {
    try {
      return zonedToUtc(input.publishedAtLocal, input.tz ?? DEFAULT_TZ);
    } catch (err) {
      throw new ApiError(422, err instanceof Error ? err.message : 'Invalid publish time');
    }
  }
  // An explicit null clears the time; `undefined` leaves it alone.
  if (input.publishedAtLocal === null) {
    if (input.status === 'scheduled') {
      throw new ApiError(422, 'A scheduled post needs a publish time');
    }
    return input.status === 'published' ? nowIso() : null;
  }

  if (input.status === 'scheduled' && !existing) {
    throw new ApiError(422, 'A scheduled post needs a publish time');
  }
  // Hitting Publish with no date set means "now", which is what the author meant.
  if (input.status === 'published' && !existing) return nowIso();

  return existing;
}

export const GET = handler(async (ctx: APIContext) => {
  requireRole(ctx, 'ambassador');

  const status = new URL(ctx.request.url).searchParams.get('status');
  const posts = await listPostsForAdmin(env.DB, status);

  return json({ posts, count: posts.length });
});

export const POST = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const input = await readJson(ctx, postInput);

  const slug = await uniqueSlugInTable(env.DB, 'posts', input.slug || input.title);
  const status = input.status ?? 'draft';
  const publishedAt = resolvePublishedAt({ ...input, status }, null);

  const row = await env.DB.prepare(
    `INSERT INTO posts (slug, title, excerpt, body_md, hero_media_id, status, pinned,
                        author_id, published_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     RETURNING id`,
  )
    .bind(
      slug,
      input.title,
      input.excerpt ?? null,
      input.bodyMd ?? '',
      input.heroMediaId ?? null,
      status,
      input.pinned ? 1 : 0,
      user.id,
      publishedAt,
    )
    .first<{ id: number }>();

  if (!row) throw new ApiError(500, 'Insert did not return an id');

  const tags = await replacePostTags(env.DB, row.id, input.tags ?? []);

  await recordAudit(env.DB, {
    actorId: user.id,
    action: 'create',
    entity: 'post',
    entityId: row.id,
    diff: { title: input.title, slug, status, publishedAt, tags },
  });

  return json({ id: row.id, slug, status, publishedAt, tags }, 201);
});
