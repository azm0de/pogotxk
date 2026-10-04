/**
 * Media library — upload to R2 and list what is there.
 *
 * Uploads are multipart so a browser can post a File directly. Attribution
 * fields ride along with the file because the moment to capture a photo credit
 * is when someone adds the photo, not later.
 *
 * Order of work, and why (admin audit, 2026-10, B-06): every field is checked
 * — including that the POI exists — before a byte reaches R2. Then the object
 * goes in, then the media row, its POI link and its audit entry go in as one
 * batch. If that batch fails, the object is deleted again, so there is never a
 * file no row points at, nor a row the audit cannot account for.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { ApiError, handler, json, requireRole, requireRowExists, validationFailed } from '~/lib/api';
import { auditStatement } from '~/lib/db/audit';
import { readImageSize } from '~/lib/image-size';
import { httpUrlOrNull } from '~/lib/safe-url';
import { slugify } from '~/lib/slug';
import { MEDIA_KINDS, MEDIA_TEXT_LIMITS, type MediaKind } from './media/[id]';

export const prerender = false;

const MAX_BYTES = 10 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

type ImageMime = keyof typeof EXT_BY_MIME;

/** The same four bytes, as text — for the container formats below. */
function ascii(bytes: Uint8Array, from: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(from, from + length));
}

/**
 * What the bytes actually are, by their signature, or null.
 *
 * `file.type` is whatever the browser — or anyone with curl — says it is, and
 * it becomes the `content-type` R2 serves the object with. The old check only
 * asked "is this *some* image" and skipped WebP and AVIF entirely, so a PNG
 * labelled as GIF, or anything at all labelled as WebP, went straight through
 * (admin audit, 2026-10, B-07).
 */
export function sniffImage(bytes: Uint8Array): ImageMime | null {
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v)
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  // ISO-BMFF: `ftyp` at offset 4, then the major brand and the compatible
  // brands. An AVIF names `avif` (still) or `avis` (sequence) among the first
  // few, which all sit inside the first 32 bytes.
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const head = ascii(bytes, 8, Math.min(24, bytes.length - 8));
    if (head.includes('avif') || head.includes('avis')) return 'image/avif';
  }
  return null;
}

export const GET = handler(async (ctx: APIContext) => {
  requireRole(ctx, 'ambassador');
  const url = new URL(ctx.request.url);
  const kind = url.searchParams.get('kind');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);

  const rows = await env.DB.prepare(
    `SELECT id, r2_key, mime, width, height, bytes, alt, caption, credit,
            source_title, source_date, source_url, kind, lat, lng, created_at
       FROM media
      WHERE (?1 IS NULL OR kind = ?1)
      ORDER BY created_at DESC, id DESC
      LIMIT ?2`,
  )
    .bind(kind, limit)
    .all();

  return json({ media: rows.results, count: rows.results.length });
});

/** A form field as trimmed text, or null when absent or blank. */
function field(form: FormData, name: string): string | null {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** A text field held to the same ceiling the PATCH route applies (B-08). */
function capped(form: FormData, name: keyof typeof MEDIA_TEXT_LIMITS): string | null {
  const value = field(form, name);
  const max = MEDIA_TEXT_LIMITS[name];
  if (value !== null && value.length > max) {
    throw validationFailed(name, `Must be at most ${max} characters`);
  }
  return value;
}

/**
 * A coordinate, or null when the field is blank. `Number('')` is 0, so a blank
 * latitude used to be stored as the equator rather than as "no location".
 */
function coordinate(form: FormData, name: 'lat' | 'lng', limit: number): number | null {
  const raw = field(form, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < -limit || value > limit) {
    throw validationFailed(name, `Must be a number between -${limit} and ${limit}`);
  }
  return value;
}

export const POST = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');

  const form = await ctx.request.formData().catch(() => {
    throw new ApiError(400, 'Expected a multipart form upload');
  });

  const file = form.get('file');
  if (!(file instanceof File)) throw new ApiError(400, 'Missing "file"');
  if (file.size === 0) throw new ApiError(400, 'File is empty');
  if (file.size > MAX_BYTES) {
    throw new ApiError(413, `File is ${(file.size / 1048576).toFixed(1)} MB; the limit is 10 MB`);
  }

  const mime = file.type || 'application/octet-stream';
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    throw new ApiError(415, `Unsupported image type "${mime}". Use JPEG, PNG, WebP, AVIF or GIF.`);
  }

  // --- every field, before anything is stored --------------------------------
  const alt = capped(form, 'alt');
  const caption = capped(form, 'caption');
  const credit = capped(form, 'credit');
  const sourceTitle = capped(form, 'sourceTitle');
  const sourceDate = capped(form, 'sourceDate');
  const sourceUrlRaw = capped(form, 'sourceUrl');
  // The PATCH route's rule, applied here too: this becomes an href on the map
  // (admin audit, 2026-10, B-03).
  const sourceUrl = sourceUrlRaw === null ? null : httpUrlOrNull(sourceUrlRaw, MEDIA_TEXT_LIMITS.sourceUrl);
  if (sourceUrlRaw !== null && sourceUrl === null) {
    throw validationFailed('sourceUrl', 'Must be an http(s) link');
  }

  const name = field(form, 'name');
  if (name !== null && name.length > 200) throw validationFailed('name', 'Must be at most 200 characters');

  const kindRaw = field(form, 'kind') ?? 'photo';
  if (!(MEDIA_KINDS as readonly string[]).includes(kindRaw)) {
    throw validationFailed('kind', `Must be one of ${MEDIA_KINDS.join(', ')}`);
  }
  const kind = kindRaw as MediaKind;

  const poiRaw = field(form, 'poiId');
  const poiId = poiRaw === null ? null : Number(poiRaw);
  if (poiId !== null && (!Number.isInteger(poiId) || poiId <= 0)) {
    throw validationFailed('poiId', 'Must be a positive whole number');
  }
  // Before the R2 put, so a stale POI id cannot leave an orphan behind (B-06).
  await requireRowExists(env.DB, 'pois', poiId, 'poiId');

  const lat = coordinate(form, 'lat', 90);
  const lng = coordinate(form, 'lng', 180);

  const bytes = new Uint8Array(await file.arrayBuffer());

  // The bytes have to *be* the type claimed, because the claim is what R2 will
  // serve them as (B-07).
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new ApiError(415, 'File does not look like a valid image');
  if (sniffed !== mime) {
    throw new ApiError(415, `File is labelled ${mime} but its contents are ${sniffed}`);
  }
  const size = readImageSize(bytes);

  // Content-addressed by name: a stable, collision-resistant key that keeps
  // the original filename readable in the URL.
  const stem = slugify(name ?? file.name.replace(/\.[^.]+$/, '')) || 'upload';
  const suffix = crypto.randomUUID().slice(0, 8);
  const r2Key = `uploads/${stem}-${suffix}.${ext}`;

  await env.MEDIA.put(r2Key, bytes, {
    httpMetadata: {
      contentType: mime,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });

  // Every row this upload produces, in one transaction. The new media row has
  // no id until the batch runs, so the statements after it find it by R2 key,
  // which is unique.
  const mediaByKey = '(SELECT id FROM media WHERE r2_key = ?2)';
  let mediaId: number;
  try {
    const [inserted] = await env.DB.batch<{ id: number }>([
      env.DB.prepare(
        `INSERT INTO media (r2_key, mime, width, height, bytes, alt, caption, credit,
                            source_title, source_date, source_url, kind, zone_id, lat, lng, uploaded_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 (SELECT id FROM zones ORDER BY is_default DESC, sort, id LIMIT 1),
                 ?13, ?14, ?15)
         RETURNING id`,
      ).bind(
        r2Key,
        mime,
        size?.width ?? null,
        size?.height ?? null,
        bytes.byteLength,
        alt,
        caption,
        credit,
        sourceTitle,
        sourceDate,
        sourceUrl,
        kind,
        lat,
        lng,
        user.id,
      ),
      ...(poiId
        ? [
            env.DB.prepare(
              `INSERT INTO poi_media (poi_id, media_id, sort)
               SELECT ?1, id, 0 FROM media WHERE r2_key = ?2
               ON CONFLICT DO NOTHING`,
            ).bind(poiId, r2Key),
            // Become the hero only if the POI does not already have one.
            env.DB.prepare(
              `UPDATE pois SET hero_media_id = ${mediaByKey}
                WHERE id = ?1 AND hero_media_id IS NULL`,
            ).bind(poiId, r2Key),
          ]
        : []),
      auditStatement(env.DB, {
        actorId: user.id,
        action: 'create',
        entity: 'media',
        entityId: { table: 'media', column: 'r2_key', value: r2Key },
        diff: { r2Key, bytes: bytes.byteLength, kind, poiId },
      }),
    ]);

    const id = inserted?.results[0]?.id;
    if (!id) throw new ApiError(500, 'Media insert did not return an id');
    mediaId = id;
  } catch (err) {
    // Compensate: the object is useless without its rows. If the rows did
    // commit and only the id read failed, delete them too rather than leave a
    // row pointing at a file that is about to vanish.
    await env.DB.prepare('DELETE FROM media WHERE r2_key = ?1').bind(r2Key).run().catch(() => {});
    await env.MEDIA.delete(r2Key).catch(() => {});
    throw err;
  }

  return json(
    {
      id: mediaId,
      key: r2Key,
      url: `/media/${r2Key}`,
      mime,
      width: size?.width ?? null,
      height: size?.height ?? null,
      bytes: bytes.byteLength,
    },
    201,
  );
});
