/**
 * Serves media originals out of R2.
 *
 * Keys are stable and objects are never rewritten in place, so responses are
 * immutable and cached hard. Conditional requests are honoured so a warm
 * browser revalidates with a 304 rather than re-downloading.
 *
 *   /media/legacy/bramletfield.jpg
 *
 * Resizing is deliberately not done here. Astro's Cloudflare image service
 * rewrites `<Image>` sources through `/cdn-cgi/image/`, which transforms these
 * URLs at the edge once the zone is live. Doing it twice would burn the free
 * plan's 5,000 monthly transformations for no gain.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export async function GET({ params, request }: APIContext): Promise<Response> {
  const key = params.key;
  if (!key) return new Response('Not found', { status: 404 });

  // R2 keys are opaque, but refuse traversal-looking input outright rather than
  // relying on the bucket to be forgiving.
  if (key.includes('..') || key.startsWith('/')) {
    return new Response('Bad request', { status: 400 });
  }

  const object = await env.MEDIA.get(key, {
    onlyIf: request.headers,
  });

  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');

  // `onlyIf` returns a bodyless object when the precondition fails — that is a
  // 304, not a 200 with an empty payload.
  if (!('body' in object) || object.body === null) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
}
