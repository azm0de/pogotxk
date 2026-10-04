/**
 * Edit the attribution on one media item.
 *
 * The upload endpoint captures credits at the moment a photo is added, which is
 * the right moment — but it left no way to correct one afterwards. Every credit
 * on the site arrived through the legacy import, so until this existed, fixing a
 * photographer's name meant hand-writing SQL against production.
 *
 * Only the attribution fields are editable. The R2 key, mime, dimensions and
 * byte count describe the stored object and changing them here would make the
 * row disagree with the file.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ApiError, handler, intParam, json, readJson, requireRole } from '~/lib/api';
import { auditStatement, diffFields } from '~/lib/db/audit';
import { isHttpUrl } from '~/lib/safe-url';

export const prerender = false;

/**
 * Empty string means "clear this field", which is why each is nullable rather
 * than optional-only: an admin deleting the contents of a credit box is asking
 * for the credit to go away, not to be left alone.
 */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => (v.trim() === '' ? null : v.trim()))
    .nullable()
    .optional();

/**
 * The ceilings on each attribution field, shared with the upload route so a
 * caption that saves here is never refused there, or the reverse (admin audit,
 * 2026-10, B-08).
 */
export const MEDIA_TEXT_LIMITS = {
  alt: 500,
  caption: 1000,
  credit: 300,
  sourceTitle: 300,
  // Kept as free text rather than a date: legacy rows hold things like
  // "November 3, 2024" and rewriting them would lose what the article said.
  sourceDate: 60,
  sourceUrl: 500,
} as const;

/**
 * Every kind the schema accepts — the CHECK in 0001_initial.sql. The route
 * used to accept only the first two, so an editor opening an imported row
 * (`import`) could not save even its alt text without changing what it was.
 */
export const MEDIA_KINDS = ['photo', 'community_photo', 'doc', 'import'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

const patchInput = z.object({
  alt: text(MEDIA_TEXT_LIMITS.alt),
  caption: text(MEDIA_TEXT_LIMITS.caption),
  credit: text(MEDIA_TEXT_LIMITS.credit),
  sourceTitle: text(MEDIA_TEXT_LIMITS.sourceTitle),
  sourceDate: text(MEDIA_TEXT_LIMITS.sourceDate),
  /**
   * Checked only when it is in the body. The check used to run on the merged
   * row, so a legacy `source_url` that predates it made every later edit to
   * that row fail — fixing a typo in the alt text included (admin audit,
   * 2026-10, B-04). A stored bad value cannot reach an href regardless: the
   * map read model filters it (`~/lib/db/map`).
   */
  sourceUrl: text(MEDIA_TEXT_LIMITS.sourceUrl).refine(
    (v) => v === null || v === undefined || isHttpUrl(v, MEDIA_TEXT_LIMITS.sourceUrl),
    'Must be an http(s) link',
  ),
  kind: z.enum(MEDIA_KINDS).optional(),
});

interface MediaRow {
  id: number;
  r2_key: string;
  alt: string | null;
  caption: string | null;
  credit: string | null;
  source_title: string | null;
  source_date: string | null;
  source_url: string | null;
  kind: string;
}

export const PATCH = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const id = intParam(ctx, 'id');
  const input = await readJson(ctx, patchInput);

  const before = await env.DB.prepare(
    `SELECT id, r2_key, alt, caption, credit, source_title, source_date, source_url, kind
       FROM media WHERE id = ?1`,
  )
    .bind(id)
    .first<MediaRow>();
  if (!before) throw new ApiError(404, 'Media not found');

  // `undefined` means the field was not sent; `null` means clear it. Collapsing
  // the two would wipe every field a partial form did not include.
  const keep = <T>(next: T | undefined, current: T): T => (next === undefined ? current : next);

  const next = {
    alt: keep(input.alt, before.alt),
    caption: keep(input.caption, before.caption),
    credit: keep(input.credit, before.credit),
    source_title: keep(input.sourceTitle, before.source_title),
    source_date: keep(input.sourceDate, before.source_date),
    source_url: keep(input.sourceUrl, before.source_url),
    kind: keep(input.kind, before.kind),
  };

  const diff = diffFields(before as unknown as Record<string, unknown>, next);

  // The edit and its audit row commit together (admin audit, 2026-10, B-15).
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE media SET alt = ?2, caption = ?3, credit = ?4, source_title = ?5,
                        source_date = ?6, source_url = ?7, kind = ?8
        WHERE id = ?1`,
    ).bind(
      id,
      next.alt,
      next.caption,
      next.credit,
      next.source_title,
      next.source_date,
      next.source_url,
      next.kind,
    ),
    ...(diff
      ? [auditStatement(env.DB, { actorId: user.id, action: 'update', entity: 'media', entityId: id, diff })]
      : []),
  ]);

  return json({ id, changed: diff !== null });
});
