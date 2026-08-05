/**
 * Media library — upload to R2 and list what is there.
 *
 * Uploads are multipart so a browser can post a File directly. Attribution
 * fields ride along with the file because the moment to capture a photo credit
 * is when someone adds the photo, not later.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { ApiError, handler, json, requireRole } from '~/lib/api';
import { recordAudit } from '~/lib/db/audit';
import { readImageSize } from '~/lib/image-size';
import { slugify } from '~/lib/slug';

export const prerender = false;

const MAX_BYTES = 10 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

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

  const text = (name: string): string | null => {
    const v = form.get(name);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };

  const kind = text('kind') === 'community_photo' ? 'community_photo' : 'photo';
  const poiId = Number(form.get('poiId')) || null;
  const lat = Number(form.get('lat'));
  const lng = Number(form.get('lng'));

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Verify the bytes actually are the image type claimed — `file.type` is
  // supplied by the client and a mislabelled upload would poison the CDN
  // content-type.
  const size = readImageSize(bytes);
  if (!size && mime !== 'image/webp' && mime !== 'image/avif') {
    throw new ApiError(415, 'File does not look like a valid image');
  }

  // Content-addressed by name: a stable, collision-resistant key that keeps
  // the original filename readable in the URL.
  const stem = slugify(text('name') ?? file.name.replace(/\.[^.]+$/, '')) || 'upload';
  const suffix = crypto.randomUUID().slice(0, 8);
  const r2Key = `uploads/${stem}-${suffix}.${ext}`;

  await env.MEDIA.put(r2Key, bytes, {
    httpMetadata: {
      contentType: mime,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });

  let mediaId: number;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO media (r2_key, mime, width, height, bytes, alt, caption, credit,
                          source_title, source_date, source_url, kind, zone_id, lat, lng, uploaded_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
               (SELECT id FROM zones ORDER BY is_default DESC, sort, id LIMIT 1),
               ?13, ?14, ?15)
       RETURNING id`,
    )
      .bind(
        r2Key,
        mime,
        size?.width ?? null,
        size?.height ?? null,
        bytes.byteLength,
        text('alt'),
        text('caption'),
        text('credit'),
        text('sourceTitle'),
        text('sourceDate'),
        text('sourceUrl'),
        kind,
        Number.isFinite(lat) ? lat : null,
        Number.isFinite(lng) ? lng : null,
        user.id,
      )
      .first<{ id: number }>();

    if (!row) throw new ApiError(500, 'Media insert did not return an id');
    mediaId = row.id;
  } catch (err) {
    // Do not leave an orphan object in R2 that no row points at.
    await env.MEDIA.delete(r2Key).catch(() => {});
    throw err;
  }

  if (poiId) {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO poi_media (poi_id, media_id, sort) VALUES (?1, ?2, 0) ON CONFLICT DO NOTHING',
      ).bind(poiId, mediaId),
      // Become the hero only if the POI does not already have one.
      env.DB.prepare(
        'UPDATE pois SET hero_media_id = ?2 WHERE id = ?1 AND hero_media_id IS NULL',
      ).bind(poiId, mediaId),
    ]);
  }

  await recordAudit(env.DB, {
    actorId: user.id,
    action: 'create',
    entity: 'media',
    entityId: mediaId,
    diff: { r2Key, bytes: bytes.byteLength, kind, poiId },
  });

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
