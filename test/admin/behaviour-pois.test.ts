/**
 * What the POI routes do once a caller is through the gate.
 *
 * The matrix proves who may call them; this proves what they write — field
 * validation, ids that point nowhere answered as 422 rather than a foreign-key
 * 500 (admin audit, 2026-10, B-05), partial updates, the archive-versus-delete
 * split and its cascade, and the audit row each change leaves behind.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedMedia, seedPoi, seedZone } from '../helpers/factories';
import {
  auditRows,
  rowCount,
  signedIn,
  withFailingAudit,
  write,
  type ErrorBody,
} from './surface';

interface PoiRow {
  id: number;
  zone_id: number;
  slug: string;
  name: string;
  type: string;
  description: string | null;
  sponsor: string | null;
  status: string;
  hero_media_id: number | null;
  is_campsite: number;
}

async function poiRow(id: number): Promise<PoiRow | null> {
  return env.DB.prepare('SELECT * FROM pois WHERE id = ?1').bind(id).first<PoiRow>();
}

function paths(body: ErrorBody): string[] {
  return (body.detail as { path: string }[]).map((d) => d.path);
}

const VALID = { name: 'Fountain', type: 'pokestop', lat: 33.4735, lng: -94.0815 };

describe('POST /api/admin/pois — validation', () => {
  it.each([
    ['an empty name', { ...VALID, name: ' ' }, 'name'],
    ['an oversize name', { ...VALID, name: 'x'.repeat(201) }, 'name'],
    ['a type outside the enum', { ...VALID, type: 'pokecenter' }, 'type'],
    ['a latitude off the planet', { ...VALID, lat: 91 }, 'lat'],
    ['a longitude off the planet', { ...VALID, lng: -181 }, 'lng'],
    ['a status outside the enum', { ...VALID, status: 'live' }, 'status'],
  ])('refuses %s with 422 and writes nothing', async (_label, body, field) => {
    const admin = await signedIn();
    await seedZone(env.DB);

    const res = await admin.send('/api/admin/pois', write('POST', body));

    expect(res.status).toBe(422);
    expect(paths((await res.json()) as ErrorBody)).toContain(field);
    expect(await rowCount('pois')).toBe(0);
    expect(await rowCount('audit_log')).toBe(0);
  });

  it.each([
    ['zoneId', { zoneId: 999 }],
    ['heroMediaId', { heroMediaId: 999 }],
  ])('refuses a %s that does not exist with 422, naming it', async (field, extra) => {
    const admin = await signedIn();
    await seedZone(env.DB);

    const res = await admin.send('/api/admin/pois', write('POST', { ...VALID, ...extra }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Validation failed',
      detail: [{ path: field, message: 'does not exist' }],
    });
    expect(await rowCount('pois')).toBe(0);
  });
});

describe('POST /api/admin/pois — what it writes', () => {
  it('lands as pending in the default zone with a unique slug, and is audited', async () => {
    const ambassador = await signedIn('ambassador');
    const zone = await seedZone(env.DB);
    await seedPoi(env.DB, { slug: 'fountain' });

    const res = await ambassador.send('/api/admin/pois', write('POST', VALID));

    expect(res.status).toBe(201);
    const { id, slug } = (await res.json()) as { id: number; slug: string };
    expect(slug).toBe('fountain-2');
    expect(await poiRow(id)).toMatchObject({ zone_id: zone.id, status: 'pending', type: 'pokestop' });
    expect(await auditRows()).toMatchObject([
      { actor_id: ambassador.user.id, action: 'create', entity: 'poi', entity_id: String(id) },
    ]);
  });

  it('commits nothing when the audit row cannot be written', async () => {
    const admin = await signedIn();
    await seedZone(env.DB);

    const res = await withFailingAudit(() => admin.send('/api/admin/pois', write('POST', VALID)));

    expect(res.status).toBe(500);
    expect(await rowCount('pois')).toBe(0);
  });
});

describe('PATCH /api/admin/pois/:id', () => {
  it('leaves omitted fields untouched and clears an explicit null', async () => {
    const admin = await signedIn();
    const media = await seedMedia(env.DB);
    const poi = await seedPoi(env.DB, {
      description: 'By the lake',
      sponsor: 'Local Cafe',
      heroMediaId: media.id,
      isCampsite: true,
    });

    const res = await admin.send(
      `/api/admin/pois/${poi.id}`,
      write('PATCH', { sponsor: null, heroMediaId: null }),
    );

    expect(res.status).toBe(200);
    expect(await poiRow(poi.id)).toMatchObject({
      name: poi.name,
      description: 'By the lake',
      is_campsite: 1,
      sponsor: null,
      hero_media_id: null,
    });
  });

  it.each([
    ['zoneId', { zoneId: 999 }],
    ['heroMediaId', { heroMediaId: 999 }],
  ])('refuses a %s that does not exist with 422', async (field, body) => {
    const admin = await signedIn();
    const poi = await seedPoi(env.DB);

    const res = await admin.send(`/api/admin/pois/${poi.id}`, write('PATCH', body));

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ detail: [{ path: field, message: 'does not exist' }] });
  });

  it('re-slugs on a rename and audits only what changed', async () => {
    const admin = await signedIn();
    const poi = await seedPoi(env.DB, { name: 'Old Name', slug: 'old-name' });

    const res = await admin.send(`/api/admin/pois/${poi.id}`, write('PATCH', { name: 'New Name' }));

    expect(await res.json()).toMatchObject({ slug: 'new-name', changed: true });
    const [row] = await auditRows();
    expect(row).toMatchObject({ actor_id: admin.user.id, action: 'update', entity_id: String(poi.id) });
    expect(Object.keys(JSON.parse(row!.diff_json!)).sort()).toEqual(['name', 'slug']);
  });

  it('leaves the row as it was when the audit row cannot be written', async () => {
    const admin = await signedIn();
    const poi = await seedPoi(env.DB, { name: 'Steady' });

    const res = await withFailingAudit(() =>
      admin.send(`/api/admin/pois/${poi.id}`, write('PATCH', { name: 'Moved' })),
    );

    expect(res.status).toBe(500);
    expect((await poiRow(poi.id))?.name).toBe('Steady');
  });
});

describe('DELETE /api/admin/pois/:id', () => {
  it('archives by default and keeps its photos linked', async () => {
    const ambassador = await signedIn('ambassador');
    const poi = await seedPoi(env.DB);
    const media = await seedMedia(env.DB);
    await env.DB.prepare('INSERT INTO poi_media (poi_id, media_id) VALUES (?1, ?2)')
      .bind(poi.id, media.id)
      .run();

    const res = await ambassador.send(`/api/admin/pois/${poi.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect((await poiRow(poi.id))?.status).toBe('archived');
    expect(await rowCount('poi_media')).toBe(1);
    expect(await auditRows()).toMatchObject([{ action: 'archive', entity: 'poi' }]);
  });

  it('hard-deletes for an admin, and the photo links cascade away', async () => {
    const admin = await signedIn('admin');
    const poi = await seedPoi(env.DB);
    const media = await seedMedia(env.DB);
    await env.DB.prepare('INSERT INTO poi_media (poi_id, media_id) VALUES (?1, ?2)')
      .bind(poi.id, media.id)
      .run();

    const res = await admin.send(`/api/admin/pois/${poi.id}?hard=1`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(await poiRow(poi.id)).toBeNull();
    expect(await rowCount('poi_media')).toBe(0);
    // The photo itself is not the POI's to delete.
    expect(await rowCount('media')).toBe(1);
    expect(await auditRows()).toMatchObject([
      { actor_id: admin.user.id, action: 'delete', entity: 'poi', entity_id: String(poi.id) },
    ]);
  });
});

describe('GET /api/admin/pois', () => {
  it('states its cap and the true total, and is never cached', async () => {
    const admin = await signedIn();
    await seedPoi(env.DB);
    await seedPoi(env.DB, { status: 'pending' });

    const all = await admin.send('/api/admin/pois');
    expect(all.headers.get('cache-control')).toBe('private, no-store');
    expect(await all.json()).toMatchObject({ count: 2, total: 2, limit: 1000, truncated: false });

    // The total counts what the filter selects, not the whole table.
    const pending = await admin.send('/api/admin/pois?status=pending');
    expect(await pending.json()).toMatchObject({ count: 1, total: 1 });
  });
});
