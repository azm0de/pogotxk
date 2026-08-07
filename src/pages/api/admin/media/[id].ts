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
import { diffFields, recordAudit } from '~/lib/db/audit';

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

const patchInput = z.object({
  alt: text(500),
  caption: text(1000),
  credit: text(300),
  sourceTitle: text(300),
  // Kept as free text rather than a date: legacy rows hold things like
  // "November 3, 2024" and rewriting them would lose what the article said.
  sourceDate: text(60),
  sourceUrl: text(500),
  kind: z.enum(['photo', 'community_photo']).optional(),
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

  // A source URL should be a real http(s) link, not a scheme that executes.
  if (next.source_url) {
    let parsed: URL;
    try {
      parsed = new URL(next.source_url);
    } catch {
      throw new ApiError(400, 'Source URL is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError(400, 'Source URL must be http or https');
    }
  }

  await env.DB.prepare(
    `UPDATE media SET alt = ?2, caption = ?3, credit = ?4, source_title = ?5,
                      source_date = ?6, source_url = ?7, kind = ?8
      WHERE id = ?1`,
  )
    .bind(
      id,
      next.alt,
      next.caption,
      next.credit,
      next.source_title,
      next.source_date,
      next.source_url,
      next.kind,
    )
    .run();

  const diff = diffFields(before as unknown as Record<string, unknown>, next);
  if (diff) {
    await recordAudit(env.DB, {
      actorId: user.id,
      action: 'update',
      entity: 'media',
      entityId: id,
      diff,
    });
  }

  return json({ id, changed: diff !== null });
});
