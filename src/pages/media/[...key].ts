/**
 * Serves media originals out of R2.
 *
 * Keys are stable and objects are never rewritten in place, so responses are
 * immutable and cached hard. Conditional requests are honoured so a warm
 * browser revalidates with a 304 rather than re-downloading.
 *
 *   /media/legacy/bramletfield.jpg
 *   /media/hero/eevee-forest.mp4
 *
 * Resizing is deliberately not done here. Astro's Cloudflare image service
 * rewrites `<Image>` sources through `/cdn-cgi/image/`, which transforms these
 * URLs at the edge once the zone is live. Doing it twice would burn the free
 * plan's 5,000 monthly transformations for no gain.
 *
 * --- byte ranges ------------------------------------------------------------
 *
 * Range support is what makes video work here, and it is not optional.
 *
 * Cloudflare's static asset layer does not serve ranges: ask `/hero/*.mp4` for
 * `bytes=0-1` and it answers 200 with all 656KB and no `Accept-Ranges` at all.
 * Desktop Chrome tolerates that. iOS Safari does not — it probes with a range
 * request before playing any `<video>`, treats a 200-with-everything as a
 * resource it cannot stream, and silently refuses to play. On the home page
 * that meant `playing` never fired, `data-hero-video` was never set, and every
 * iPhone got the Lucario fallback instead of the hero video, indefinitely.
 *
 * R2 does ranged reads natively, so the bytes are sliced at source rather than
 * buffered here.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

type ParsedRange = { offset: number; length?: number } | { suffix: number } | 'invalid';

/**
 * `bytes=a-b`, `bytes=a-` and `bytes=-n`, which is the whole of what a browser
 * sends for media. Multipart ranges are legal in the spec and never used by
 * `<video>`; anything not matching is treated as absent rather than rejected,
 * which is what RFC 9110 asks for.
 */
function parseRange(header: string | null): ParsedRange | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  // Suffix form: the last n bytes.
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    return suffix > 0 ? { suffix } : 'invalid';
  }

  const offset = Number(rawStart);
  if (rawEnd === '') return { offset };

  const end = Number(rawEnd);
  return end < offset ? 'invalid' : { offset, length: end - offset + 1 };
}

export async function GET({ params, request }: APIContext): Promise<Response> {
  const key = params.key;
  if (!key) return new Response('Not found', { status: 404 });

  // R2 keys are opaque, but refuse traversal-looking input outright rather than
  // relying on the bucket to be forgiving.
  if (key.includes('..') || key.startsWith('/')) {
    return new Response('Bad request', { status: 400 });
  }

  const range = parseRange(request.headers.get('range'));

  if (range === 'invalid') {
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { 'accept-ranges': 'bytes' },
    });
  }

  let object: R2ObjectBody | R2Object | null;
  try {
    object = await env.MEDIA.get(key, {
      // Conditional headers are only applied to whole-body requests. Combining
      // them with a range makes the 304-vs-206 decision subtle for no gain here,
      // where every object is immutable and already cached for a year.
      ...(range ? { range } : { onlyIf: request.headers }),
    });
  } catch {
    // R2 *throws* for a range starting past the end of the object rather than
    // returning something to inspect, so the size check further down never gets
    // the chance to answer 416 — without this the reply is a 500. The extra
    // `head` only happens on this path, so the normal case still costs one call.
    if (!range) throw new Error('R2 get failed');
    const head = await env.MEDIA.head(key).catch(() => null);
    if (!head) return new Response('Not found', { status: 404 });
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${head.size}` },
    });
  }

  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  // Advertised on every response, not just ranged ones — it is how a client
  // knows it may ask for a range at all.
  headers.set('accept-ranges', 'bytes');

  // `onlyIf` returns a bodyless object when the precondition fails — that is a
  // 304, not a 200 with an empty payload.
  if (!('body' in object) || object.body === null) {
    return new Response(null, { status: 304, headers });
  }

  if (range) {
    // What R2 actually served, which is not necessarily what was asked for: an
    // open-ended or over-long range is clamped to the object.
    const served = object.range as
      | { offset?: number; length?: number; suffix?: number }
      | undefined;

    let start: number;
    let end: number;
    if (served && typeof served.suffix === 'number') {
      start = object.size - served.suffix;
      end = object.size - 1;
    } else {
      start = served?.offset ?? 0;
      end = served?.length != null ? start + served.length - 1 : object.size - 1;
    }

    // A start past the end of the object is unsatisfiable. The spec wants the
    // object's full size advertised in the reply so the client can correct.
    if (start >= object.size) {
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${object.size}` },
      });
    }

    headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
    headers.set('content-length', String(end - start + 1));
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { headers });
}
