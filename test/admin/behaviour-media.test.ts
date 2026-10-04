/**
 * What the media routes do once a caller is through the gate — and what the
 * map and the `/media/` route do with what they stored.
 *
 * The findings this file pins (admin audit, 2026-10):
 *
 *   B-03  the upload accepted a `javascript:` source URL that the edit route
 *         would have refused, and the map popup made it an href;
 *   B-04  the edit route checked the *merged* row, so one bad legacy value
 *         blocked every later edit, alt text included;
 *   B-06  a bad POI id was discovered after the object was in R2, leaving an
 *         orphan file and a half-linked row;
 *   B-07  the bytes were never compared with the type they claimed, and WebP
 *         and AVIF were not checked at all;
 *   B-08  the upload had no length limits the edit route did not share.
 *
 * R2 is asserted on directly — "zero objects" is the only honest proof that a
 * refused upload left nothing behind.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedMedia, seedPoi, seedZone } from '../helpers/factories';
import {
  auditRows,
  ORIGIN,
  pngBytes,
  rowCount,
  signedIn,
  withFailingAudit,
  write,
  type ErrorBody,
} from './surface';

/* ------------------------------------------------------------- the bytes */

function bytes(...parts: (number[] | string)[]): Uint8Array<ArrayBuffer> {
  const flat: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') for (const ch of part) flat.push(ch.charCodeAt(0));
    else flat.push(...part);
  }
  return new Uint8Array(flat);
}

const GIF = (): Uint8Array<ArrayBuffer> => bytes('GIF89a', [2, 0, 3, 0, 0, 0, 0, 0, 0, 0]);
const JPEG = (): Uint8Array<ArrayBuffer> => bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], 'JFIF', [0, 1, 1, 0]);
const WEBP = (): Uint8Array<ArrayBuffer> => bytes('RIFF', [26, 0, 0, 0], 'WEBP', 'VP8 ', [10, 0, 0, 0]);
const AVIF = (): Uint8Array<ArrayBuffer> =>
  bytes([0, 0, 0, 28], 'ftyp', 'avif', [0, 0, 0, 0], 'avifmif1miaf');
const TEXT = (): Uint8Array<ArrayBuffer> => bytes('<script>alert(1)</script>');

interface UploadOptions {
  bytes?: Uint8Array<ArrayBuffer>;
  type?: string;
  name?: string;
  fields?: Record<string, string>;
}

function upload({ bytes: body = pngBytes(), type = 'image/png', name = 'shot.png', fields = {} }: UploadOptions = {}) {
  const form = new FormData();
  form.set('file', new File([body], name, { type }), name);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return { method: 'POST', body: form };
}

async function objectCount(): Promise<number> {
  return (await env.MEDIA.list()).objects.length;
}

/** Nothing in D1 or R2 that an upload would have produced. */
async function expectNothingStored(): Promise<void> {
  expect(await rowCount('media')).toBe(0);
  expect(await rowCount('poi_media')).toBe(0);
  expect(await rowCount('audit_log')).toBe(0);
  expect(await objectCount()).toBe(0);
}

/* ---------------------------------------------------------------- upload */

describe('POST /api/admin/media — refused before anything is stored', () => {
  it('a POI that does not exist: 422, no row, no object (B-06)', async () => {
    const admin = await signedIn();

    const res = await admin.send('/api/admin/media', upload({ fields: { poiId: '999' } }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Validation failed',
      detail: [{ path: 'poiId', message: 'does not exist' }],
    });
    await expectNothingStored();
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['JAVASCRIPT: in capitals', 'JAVASCRIPT:alert(1)'],
    ['data:', 'data:text/html,<b>hi</b>'],
    ['a scheme-relative link', '//evil.example/a'],
    ['a tab-split scheme', 'java\tscript:alert(1)'],
  ])('a %s source URL: 422 (B-03)', async (_label, sourceUrl) => {
    const admin = await signedIn();

    const res = await admin.send('/api/admin/media', upload({ fields: { sourceUrl } }));

    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).detail).toEqual([
      { path: 'sourceUrl', message: 'Must be an http(s) link' },
    ]);
    await expectNothingStored();
  });

  it.each([
    ['alt', 'x'.repeat(501)],
    ['caption', 'x'.repeat(1001)],
    ['credit', 'x'.repeat(301)],
    ['sourceTitle', 'x'.repeat(301)],
    ['sourceDate', 'x'.repeat(61)],
    ['lat', '91'],
    ['lat', 'north'],
    ['lng', '-181'],
    ['kind', 'video'],
    ['poiId', '1.5'],
  ])('%s = %j: 422 (B-08)', async (field, value) => {
    const admin = await signedIn();

    const res = await admin.send('/api/admin/media', upload({ fields: { [field]: value } }));

    expect(res.status).toBe(422);
    expect((((await res.json()) as ErrorBody).detail as { path: string }[])[0]?.path).toBe(field);
    await expectNothingStored();
  });

  it.each([
    ['PNG bytes labelled as GIF', pngBytes(), 'image/gif'],
    ['GIF bytes labelled as PNG', GIF(), 'image/png'],
    ['PNG bytes labelled as WebP', pngBytes(), 'image/webp'],
    ['PNG bytes labelled as AVIF', pngBytes(), 'image/avif'],
    ['a script labelled as WebP', TEXT(), 'image/webp'],
    ['a script labelled as JPEG', TEXT(), 'image/jpeg'],
  ])('%s: 415 (B-07)', async (_label, body, type) => {
    const admin = await signedIn();

    const res = await admin.send('/api/admin/media', upload({ bytes: body, type }));

    expect(res.status).toBe(415);
    await expectNothingStored();
  });
});

describe('POST /api/admin/media — accepted', () => {
  it.each([
    ['PNG', pngBytes(), 'image/png', 'png'],
    ['GIF', GIF(), 'image/gif', 'gif'],
    ['JPEG', JPEG(), 'image/jpeg', 'jpg'],
    ['WebP', WEBP(), 'image/webp', 'webp'],
    ['AVIF', AVIF(), 'image/avif', 'avif'],
  ])('%s whose bytes match its label', async (_label, body, type, ext) => {
    const admin = await signedIn();

    const res = await admin.send('/api/admin/media', upload({ bytes: body, type, name: `pic.${ext}` }));

    expect(res.status).toBe(201);
    const { key } = (await res.json()) as { key: string };
    expect(key).toMatch(new RegExp(`\\.${ext}$`));
    expect((await env.MEDIA.head(key))?.httpMetadata?.contentType).toBe(type);
  });

  it('links to the POI, becomes its hero, and is audited — all with the new id', async () => {
    const ambassador = await signedIn('ambassador');
    await seedZone(env.DB);
    const poi = await seedPoi(env.DB);

    const res = await ambassador.send(
      '/api/admin/media',
      upload({
        fields: {
          poiId: String(poi.id),
          alt: 'The fountain',
          sourceUrl: 'https://example.com/article',
          lat: '',
        },
      }),
    );

    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    const row = await env.DB.prepare('SELECT * FROM media WHERE id = ?1')
      .bind(id)
      .first<{ alt: string; source_url: string; lat: number | null; kind: string }>();
    // A blank latitude is no latitude, not the equator.
    expect(row).toMatchObject({ alt: 'The fountain', source_url: 'https://example.com/article', lat: null, kind: 'photo' });
    expect(
      await rowCount('poi_media', 'poi_id = ?1 AND media_id = ?2', poi.id, id),
    ).toBe(1);
    expect(
      (await env.DB.prepare('SELECT hero_media_id FROM pois WHERE id = ?1').bind(poi.id).first<{ hero_media_id: number }>())
        ?.hero_media_id,
    ).toBe(id);
    expect(await auditRows()).toMatchObject([
      { actor_id: ambassador.user.id, action: 'create', entity: 'media', entity_id: String(id) },
    ]);
  });

  it('removes the object again when the rows cannot be written (B-06, B-15)', async () => {
    const admin = await signedIn();
    await seedZone(env.DB);
    const poi = await seedPoi(env.DB);

    const res = await withFailingAudit(() =>
      admin.send('/api/admin/media', upload({ fields: { poiId: String(poi.id) } })),
    );

    expect(res.status).toBe(500);
    await expectNothingStored();
    expect(
      (await env.DB.prepare('SELECT hero_media_id FROM pois WHERE id = ?1').bind(poi.id).first<{ hero_media_id: number | null }>())
        ?.hero_media_id,
    ).toBeNull();
  });
});

/* ----------------------------------------------------------------- edit */

describe('PATCH /api/admin/media/:id', () => {
  it('saves an alt-only edit on a row whose stored source URL is bad (B-04)', async () => {
    const admin = await signedIn();
    const media = await seedMedia(env.DB, { sourceUrl: 'javascript:alert(1)' });

    const res = await admin.send(`/api/admin/media/${media.id}`, write('PATCH', { alt: 'Fixed alt' }));

    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT alt FROM media WHERE id = ?1').bind(media.id).first<{ alt: string }>();
    expect(row?.alt).toBe('Fixed alt');
  });

  it('refuses a bad source URL when one is sent', async () => {
    const admin = await signedIn();
    const media = await seedMedia(env.DB, { sourceUrl: 'https://example.com/ok' });

    const res = await admin.send(
      `/api/admin/media/${media.id}`,
      write('PATCH', { sourceUrl: 'vbscript:msgbox(1)' }),
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).detail).toEqual([
      { path: 'sourceUrl', message: 'Must be an http(s) link' },
    ]);
    expect(await rowCount('media', "source_url = 'https://example.com/ok'")).toBe(1);
  });

  it('clears a source URL sent as an empty string', async () => {
    const admin = await signedIn();
    const media = await seedMedia(env.DB, { sourceUrl: 'javascript:alert(1)', credit: 'Kept' });

    const res = await admin.send(`/api/admin/media/${media.id}`, write('PATCH', { sourceUrl: '' }));

    expect(res.status).toBe(200);
    expect(await rowCount('media', 'source_url IS NULL AND credit = ?1', 'Kept')).toBe(1);
  });

  it.each(['photo', 'community_photo', 'doc', 'import'])('accepts kind %s', async (kind) => {
    const admin = await signedIn();
    const media = await seedMedia(env.DB, { kind: 'import' });

    const res = await admin.send(`/api/admin/media/${media.id}`, write('PATCH', { kind }));

    expect(res.status).toBe(200);
    expect(await rowCount('media', 'kind = ?1', kind)).toBe(1);
  });

  it.each([
    ['kind', { kind: 'video' }],
    ['caption', { caption: 'x'.repeat(1001) }],
    ['alt', { alt: 'x'.repeat(501) }],
  ])('refuses a bad %s with 422', async (field, body) => {
    const admin = await signedIn();
    const media = await seedMedia(env.DB);

    const res = await admin.send(`/api/admin/media/${media.id}`, write('PATCH', body));

    expect(res.status).toBe(422);
    expect((((await res.json()) as ErrorBody).detail as { path: string }[])[0]?.path).toBe(field);
  });

  it('audits the change, and leaves the row alone when the audit cannot be written', async () => {
    const admin = await signedIn();
    const media = await seedMedia(env.DB, { credit: 'Before' });

    const refused = await withFailingAudit(() =>
      admin.send(`/api/admin/media/${media.id}`, write('PATCH', { credit: 'After' })),
    );
    expect(refused.status).toBe(500);
    expect(await rowCount('media', 'credit = ?1', 'Before')).toBe(1);

    await admin.send(`/api/admin/media/${media.id}`, write('PATCH', { credit: 'After' }));
    expect(await auditRows()).toMatchObject([
      { actor_id: admin.user.id, action: 'update', entity: 'media', entity_id: String(media.id) },
    ]);
  });
});

/* ------------------------------------------------- where the values land */

describe('the public surfaces, given rows written before the checks existed', () => {
  it('/api/map.json carries no javascript: source URL (B-03)', async () => {
    const zone = await seedZone(env.DB);
    const hero = await seedMedia(env.DB, {
      sourceUrl: 'javascript:alert(document.cookie)',
      sourceTitle: 'Gazette',
    });
    await seedPoi(env.DB, { zoneId: zone.id, heroMediaId: hero.id, status: 'published' });
    await seedMedia(env.DB, {
      kind: 'community_photo',
      zoneId: zone.id,
      lat: 33.47,
      lng: -94.08,
      sourceUrl: 'JAVASCRIPT:alert(1)',
      sourceTitle: 'Blog',
    });

    const res = await SELF.fetch(`${ORIGIN}/api/map.json`);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain('javascript:');
    const data = JSON.parse(text) as {
      pois: { photo: { sourceUrl: string | null } | null }[];
      communityPhotos: { sourceUrl: string | null }[];
    };
    expect(data.pois[0]?.photo?.sourceUrl).toBeNull();
    expect(data.communityPhotos).toHaveLength(1);
    expect(data.communityPhotos[0]?.sourceUrl).toBeNull();
  });

  it('/api/map.json keeps an http(s) source URL', async () => {
    const zone = await seedZone(env.DB);
    const hero = await seedMedia(env.DB, { sourceUrl: 'https://example.com/story', sourceTitle: 'Story' });
    await seedPoi(env.DB, { zoneId: zone.id, heroMediaId: hero.id, status: 'published' });

    const data = (await (await SELF.fetch(`${ORIGIN}/api/map.json`)).json()) as {
      pois: { photo: { sourceUrl: string | null } | null }[];
    };

    expect(data.pois[0]?.photo?.sourceUrl).toBe('https://example.com/story');
  });

  it('/media/ answers with nosniff, so a mislabelled object is never sniffed (B-07)', async () => {
    await env.MEDIA.put('uploads/legacy.png', pngBytes(), {
      httpMetadata: { contentType: 'image/png' },
    });

    const res = await SELF.fetch(`${ORIGIN}/media/uploads/legacy.png`);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    await res.arrayBuffer();
  });
});
