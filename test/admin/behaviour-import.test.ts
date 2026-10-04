/**
 * `POST /api/admin/import-legacy`, past its guard.
 *
 * The guard itself is `import-guard.test.ts`'s and the matrix's. This is about
 * what the importer does to the database, and it pins the decision taken in
 * the admin audit (2026-10, B-12): the importer runs against an empty database
 * and nothing else. `?force=1` used to clear the POI, meetup, media and shape
 * tables first, so one request could wipe the live site; it is gone, and the
 * parameter is ignored. A successful run now also leaves an `import` audit row.
 *
 * `fetch` is stubbed per test with the three legacy files. Nothing here reaches
 * pokemontxk.com — `test/setup.ts` would fail the test if it tried — and the
 * stub records every call, so "the refusal fetched nothing" is asserted rather
 * than assumed.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { seedMeetup, seedPoi, seedZone } from '../helpers/factories';
import { auditRows, contentSnapshot, ORIGIN, rowCount, signedIn } from './surface';

const LEGACY = {
  '/markers.js': `window.markers = [
    {"name":"Fountain","type":"pokestop","description":"By the lake","image":"images/fountain.jpg","lat":33.47,"lng":-94.08},
    {"name":"Big Gym","type":"gym","description":"","image":null,"lat":33.48,"lng":-94.09}
  ];`,
  '/script.js': `
    const hotspotBoundary = [[33.47,-94.08],[33.48,-94.09],[33.46,-94.07]];
    const raidRouteCoordinates = [[33.47,-94.08],[33.48,-94.09]];`,
  '/meetup.js': `window.nextMeetup = { title: "Raid hour", date: "Wednesday", time: "6 PM",
    location: "Campsite", description: "Come along" };`,
} as const;

/** Serves the three legacy files and records every request made. */
function stubLegacySite(): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(new Request(input as RequestInfo).url);
    calls.push(url.pathname);
    if (url.origin !== 'https://pokemontxk.com') {
      throw new Error(`import test: unexpected outbound request to ${url.origin}`);
    }
    const body = LEGACY[url.pathname as keyof typeof LEGACY];
    return body ? new Response(body) : new Response('not found', { status: 404 });
  });
  return calls;
}

function importRequest(query = ''): { path: string; init: { method: string } } {
  return { path: `/api/admin/import-legacy${query}`, init: { method: 'POST' } };
}

describe('the importer refuses a populated database', () => {
  it('answers 409, fetches nothing and writes nothing', async () => {
    const calls = stubLegacySite();
    const admin = await signedIn();
    await seedPoi(env.DB);
    const before = await contentSnapshot();

    const { path, init } = importRequest();
    const res = await admin.send(path, init);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe('Database already contains POIs.');
    expect(body.hint).not.toContain('force');
    expect(calls).toEqual([]);
    expect(await contentSnapshot()).toBe(before);
  });

  it('ignores ?force=1 — still 409, and every table is exactly as it was', async () => {
    const calls = stubLegacySite();
    const admin = await signedIn();
    // Everything the old force path deleted, so a regression shows up as rows gone.
    const zone = await seedZone(env.DB, { slug: 'spring-lake-park' });
    await seedPoi(env.DB, { zoneId: zone.id });
    await seedMeetup(env.DB, { zoneId: zone.id });
    const before = await contentSnapshot();

    const { path, init } = importRequest('?force=1');
    const res = await admin.send(path, init);

    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
    expect(await contentSnapshot()).toBe(before);
    expect(await rowCount('pois')).toBe(1);
    expect(await rowCount('meetups')).toBe(1);
  });
});

describe('the importer on an empty database', () => {
  it('imports, and leaves one import audit row naming the admin', async () => {
    const calls = stubLegacySite();
    const admin = await signedIn();

    const { path, init } = importRequest();
    const res = await admin.send(path, init);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ ok: true, pois: { total: 2 } });
    expect(calls.sort()).toEqual(['/markers.js', '/meetup.js', '/script.js']);

    expect(await rowCount('pois')).toBe(2);
    expect(await rowCount('zones', "slug = 'spring-lake-park'")).toBe(1);
    expect(await rowCount('meetups', "status = 'draft'")).toBe(1);

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: admin.user.id, action: 'import', entity: 'legacy' });
    expect(JSON.parse(audit[0]!.diff_json!)).toMatchObject({ pois: 2, media: 1, via: 'session' });
  });

  it('records a null actor when the bearer token, not a session, ran it', async () => {
    stubLegacySite();

    const res = await SELF.fetch(`${ORIGIN}/api/admin/import-legacy`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: 'Bearer test-import-token' },
    });

    expect(res.status).toBe(200);
    await res.json();
    const [row] = await auditRows();
    expect(row).toMatchObject({ actor_id: null, action: 'import' });
    expect(JSON.parse(row!.diff_json!)).toMatchObject({ via: 'token' });
  });

  it('a second run is refused, so an import can never run twice', async () => {
    stubLegacySite();
    const admin = await signedIn();
    const { path, init } = importRequest();

    expect((await admin.send(path, init)).status).toBe(200);
    const after = await contentSnapshot();

    expect((await admin.send(path, { method: 'POST' })).status).toBe(409);
    expect(await contentSnapshot()).toBe(after);
  });
});
