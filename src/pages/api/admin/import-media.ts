/**
 * Copies the legacy photographs from pokemontxk.com into R2.
 *
 * Split out from `/api/admin/import-legacy` because a Worker on the free plan
 * gets 50 subrequests per request and there are 72 images. This endpoint is
 * resumable: it skips anything already in R2, uploads up to `limit` per call,
 * and reports how many remain. Call it until `remaining` is 0.
 *
 *   curl -X POST "http://localhost:4321/api/admin/import-media?limit=30" \
 *        -H "Authorization: Bearer $IMPORT_TOKEN"
 *
 * R2 binding calls are not subrequests, so only the source downloads count
 * against the budget.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { json, requireImportToken } from '~/lib/admin-auth';
import { parseMarkers } from '~/lib/legacy/parse';
import { transform } from '~/lib/legacy/transform';
import { readImageSize } from '~/lib/image-size';

export const prerender = false;

const ORIGIN = 'https://pokemontxk.com';

/** Leaves headroom under the 50-subrequest free-plan cap (1 is markers.js). */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 45;

export async function POST(ctx: APIContext): Promise<Response> {
  const denied = requireImportToken(ctx.request, env);
  if (denied) return denied;

  const url = new URL(ctx.request.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  try {
    // Rebuild the key -> source URL map from the same deterministic transform
    // the metadata pass used, rather than storing source paths in the schema.
    const res = await fetch(new URL('/markers.js', ORIGIN), {
      headers: { 'user-agent': 'pogotxk-import/1.0 (+https://pokemontxk.com)' },
    });
    if (!res.ok) throw new Error(`GET /markers.js -> ${res.status}`);

    const { media } = transform(parseMarkers(await res.text()), ORIGIN);

    const uploaded: string[] = [];
    const failed: { key: string; reason: string }[] = [];
    let alreadyPresent = 0;
    let remaining = 0;

    for (const m of media) {
      if (uploaded.length >= limit) {
        remaining++;
        continue;
      }

      // head() is a binding call, not a subrequest — cheap to check every time.
      if (await env.MEDIA.head(m.r2Key)) {
        alreadyPresent++;
        continue;
      }

      try {
        const img = await fetch(m.sourceUrl, {
          headers: { 'user-agent': 'pogotxk-import/1.0 (+https://pokemontxk.com)' },
        });
        if (!img.ok) {
          failed.push({ key: m.r2Key, reason: `source returned ${img.status}` });
          continue;
        }

        const bytes = new Uint8Array(await img.arrayBuffer());
        if (bytes.byteLength === 0) {
          failed.push({ key: m.r2Key, reason: 'source returned an empty body' });
          continue;
        }

        await env.MEDIA.put(m.r2Key, bytes, {
          httpMetadata: {
            contentType: m.mime,
            // Immutable: keys are content-addressed by name and never rewritten.
            cacheControl: 'public, max-age=31536000, immutable',
          },
        });

        const size = readImageSize(bytes);
        await env.DB.prepare(
          'UPDATE media SET bytes = ?1, width = ?2, height = ?3 WHERE r2_key = ?4',
        )
          .bind(bytes.byteLength, size?.width ?? null, size?.height ?? null, m.r2Key)
          .run();

        uploaded.push(m.r2Key);
      } catch (err) {
        failed.push({ key: m.r2Key, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    const done = remaining === 0 && failed.length === 0;
    return json({
      ok: true,
      total: media.length,
      uploaded: uploaded.length,
      alreadyPresent,
      failed,
      remaining,
      done,
      next: done ? null : `POST /api/admin/import-media?limit=${limit}`,
    });
  } catch (err) {
    return json(
      { error: 'Media import failed', detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
