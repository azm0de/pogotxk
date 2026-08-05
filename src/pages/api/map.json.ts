/**
 * Map payload for the Leaflet island — zone, POIs, overlay shapes, and
 * community photo pins in one request.
 *
 *   /api/map.json            default zone
 *   /api/map.json?zone=slug  a specific zone
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { getMapData } from '~/lib/db/map';

export const prerender = false;

export async function GET({ url }: APIContext): Promise<Response> {
  const zoneSlug = url.searchParams.get('zone') ?? undefined;
  const data = await getMapData(env.DB, zoneSlug);

  if (!data) {
    return new Response(JSON.stringify({ error: 'Zone not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // POI edits should show up quickly, but a browser refresh should not
      // re-fetch 100 KB of GeoJSON either.
      'cache-control': 'public, max-age=60, stale-while-revalidate=600',
    },
  });
}
