/**
 * Single post: read for the editor, patch, delete.
 *
 * `post_tags` rows disappear with the post via ON DELETE CASCADE, so the
 * delete here is genuinely one statement.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { ApiError, handler, intParam, json, noContent, readJson, requireRole } from '~/lib/api';
import { diffFields, recordAudit } from '~/lib/db/audit';
import { getPostForAdmin, replacePostTags } from '~/lib/db/posts';
import { uniqueSlugInTable } from '~/lib/slug';
import { postInput, resolvePublishedAt } from './index';

export const prerender = false;

const patchInput = postInput.partial();

export const GET = handler(async (ctx: APIContext) => {
  requireRole(ctx, 'ambassador');
  const post = await getPostForAdmin(env.DB, intParam(ctx, 'id'));
  if (!post) throw new ApiError(404, 'Post not found');
  return json({ post });
});

export const PATCH = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const id = intParam(ctx, 'id');
  const input = await readJson(ctx, patchInput);

  const before = await getPostForAdmin(env.DB, id);
  if (!before) throw new ApiError(404, 'Post not found');

  // A slug is a permanent URL. Renaming the title of a live post must not
  // silently break every link to it, so the slug only moves when the author
  // explicitly asks for a different one.
  const slug = input.slug
    ? await uniqueSlugInTable(env.DB, 'posts', input.slug, id)
    : before.slug;

  const status = input.status ?? before.status;

  const next = {
    slug,
    title: input.title ?? before.title,
    excerpt: input.excerpt === undefined ? before.excerpt : (input.excerpt || null),
    body_md: input.bodyMd === undefined ? before.bodyMd : input.bodyMd,
    hero_media_id: input.heroMediaId === undefined ? before.heroMediaId : input.heroMediaId,
    status,
    pinned: (input.pinned === undefined ? before.pinned : input.pinned) ? 1 : 0,
    published_at: resolvePublishedAt({ ...input, status }, before.publishedAt),
  };

  await env.DB.prepare(
    `UPDATE posts SET slug = ?2, title = ?3, excerpt = ?4, body_md = ?5, hero_media_id = ?6,
                      status = ?7, pinned = ?8, published_at = ?9,
                      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?1`,
  )
    .bind(
      id,
      next.slug,
      next.title,
      next.excerpt,
      next.body_md,
      next.hero_media_id,
      next.status,
      next.pinned,
      next.published_at,
    )
    .run();

  let tags = before.tags;
  if (input.tags) tags = await replacePostTags(env.DB, id, input.tags);

  // Compare against the same key names the UPDATE writes, so the audit reads
  // like the row rather than like the request body.
  const diff =
    diffFields(
      {
        slug: before.slug,
        title: before.title,
        excerpt: before.excerpt,
        body_md: before.bodyMd,
        hero_media_id: before.heroMediaId,
        status: before.status,
        pinned: before.pinned ? 1 : 0,
        published_at: before.publishedAt,
      },
      next,
    ) ?? {};

  if (input.tags && tags.join(',') !== before.tags.join(',')) {
    diff.tags = { from: before.tags, to: tags };
  }

  const changed = Object.keys(diff).length > 0;
  if (changed) {
    await recordAudit(env.DB, {
      actorId: user.id,
      action: 'update',
      entity: 'post',
      entityId: id,
      // Bodies can be tens of kilobytes; logging the fact of the edit keeps the
      // audit table from becoming a second copy of the blog.
      diff: { ...diff, body_md: diff.body_md ? { changed: true } : undefined },
    });
  }

  return json({ id, slug: next.slug, status: next.status, publishedAt: next.published_at, tags, changed });
});

export const DELETE = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const id = intParam(ctx, 'id');

  const before = await getPostForAdmin(env.DB, id);
  if (!before) throw new ApiError(404, 'Post not found');

  await env.DB.prepare('DELETE FROM posts WHERE id = ?1').bind(id).run();

  await recordAudit(env.DB, {
    actorId: user.id,
    action: 'delete',
    entity: 'post',
    entityId: id,
    diff: { title: before.title, slug: before.slug, status: before.status },
  });

  return noContent();
});
