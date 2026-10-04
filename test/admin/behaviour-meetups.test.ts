/**
 * What the meetup routes do once a caller is through the gate, and what the
 * public pages do with what they stored.
 *
 * Two of these findings (admin audit, 2026-10) were about the *render*, not
 * the route: a zone `Intl` does not know took the home page down with a 500
 * (B-01), and `z.string().url()` let `javascript:` through to the RSVP button's
 * href (B-02). So the routes are tested for refusing those values, and the
 * pages are tested with the values seeded straight into D1 — the state a row
 * written before the fix is already in.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isoIn, seedMeetup, seedPoi, seedZone } from '../helpers/factories';
import { mockWebhook, withWebhook } from '../flares/harness';
import { auditRows, ORIGIN, rowCount, signedIn, write, type ErrorBody } from './surface';

interface MeetupRow {
  id: number;
  slug: string;
  title: string;
  description_md: string | null;
  starts_at: string;
  tz: string;
  poi_id: number | null;
  location_text: string | null;
  campfire_url: string | null;
  recurrence_rule: string | null;
  status: string;
  announce_requested: number;
  announced_at: string | null;
}

async function meetupRow(id: number): Promise<MeetupRow | null> {
  return env.DB.prepare('SELECT * FROM meetups WHERE id = ?1').bind(id).first<MeetupRow>();
}

function paths(body: ErrorBody): string[] {
  return (body.detail as { path: string }[]).map((d) => d.path);
}

const VALID = { title: 'Wednesday walk', startsAtLocal: '2026-10-07T18:00' };

describe('POST /api/admin/meetups — validation', () => {
  it.each([
    ['an empty title', { ...VALID, title: '' }, 'title'],
    ['an oversize title', { ...VALID, title: 'x'.repeat(201) }, 'title'],
    ['a malformed start', { ...VALID, startsAtLocal: 'next wednesday' }, 'startsAtLocal'],
    ['a status outside the enum', { ...VALID, status: 'postponed' }, 'status'],
    ['an unknown time zone', { ...VALID, tz: 'Bad/Zone' }, 'tz'],
    ['a javascript: Campfire link', { ...VALID, campfireUrl: 'javascript:alert(1)' }, 'campfireUrl'],
    ['a data: Campfire link', { ...VALID, campfireUrl: 'data:text/html,hi' }, 'campfireUrl'],
    ['a scheme-relative Campfire link', { ...VALID, campfireUrl: '//evil.example' }, 'campfireUrl'],
    ['a recurrence rule the calendar cannot read', { ...VALID, recurrenceRule: 'every wednesday' }, 'recurrenceRule'],
    ['an RRULE with an unknown frequency', { ...VALID, recurrenceRule: 'FREQ=HOURLY' }, 'recurrenceRule'],
    ['an RRULE with a newline in it', { ...VALID, recurrenceRule: 'FREQ=WEEKLY\nX-EVIL:1' }, 'recurrenceRule'],
  ])('refuses %s with 422 and writes nothing', async (_label, body, field) => {
    const admin = await signedIn();

    const res = await admin.send('/api/admin/meetups', write('POST', body));

    expect(res.status).toBe(422);
    const json = (await res.json()) as ErrorBody;
    expect(json.error).toBe('Validation failed');
    expect(paths(json)).toContain(field);
    expect(await rowCount('meetups')).toBe(0);
    expect(await rowCount('audit_log')).toBe(0);
  });

  it('refuses a date that is not on the calendar instead of rolling it into March', async () => {
    const admin = await signedIn();

    const res = await admin.send(
      '/api/admin/meetups',
      write('POST', { ...VALID, startsAtLocal: '2026-02-30T18:00' }),
    );

    expect(res.status).toBe(422);
    expect(await rowCount('meetups')).toBe(0);
  });

  it('refuses a POI that does not exist, naming the field', async () => {
    const admin = await signedIn();

    const res = await admin.send('/api/admin/meetups', write('POST', { ...VALID, poiId: 4040 }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Validation failed',
      detail: [{ path: 'poiId', message: 'does not exist' }],
    });
    expect(await rowCount('meetups')).toBe(0);
  });

  it('accepts a rule the calendar can expand, an http(s) link, and a real zone', async () => {
    const admin = await signedIn();

    const res = await admin.send(
      '/api/admin/meetups',
      write('POST', {
        ...VALID,
        tz: 'America/New_York',
        recurrenceRule: 'FREQ=WEEKLY;BYDAY=WE',
        campfireUrl: 'https://campfire.nianticlabs.com/discover/meetup/abc',
      }),
    );

    expect(res.status).toBe(201);
    const { id, startsAt } = (await res.json()) as { id: number; startsAt: string };
    // 6 PM Eastern, daylight time.
    expect(startsAt).toBe('2026-10-07T22:00:00Z');
    expect(await meetupRow(id)).toMatchObject({
      tz: 'America/New_York',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE',
      campfire_url: 'https://campfire.nianticlabs.com/discover/meetup/abc',
    });
  });
});

describe('POST /api/admin/meetups — what it writes', () => {
  it('defaults to a draft in Central, and audits the create with the new id', async () => {
    const admin = await signedIn('ambassador');

    const res = await admin.send('/api/admin/meetups', write('POST', VALID));

    expect(res.status).toBe(201);
    const { id, slug } = (await res.json()) as { id: number; slug: string };
    expect(slug).toBe('wednesday-walk-2026-10-07');
    expect(await meetupRow(id)).toMatchObject({ status: 'draft', tz: 'America/Chicago' });
    expect(await auditRows()).toMatchObject([
      { actor_id: admin.user.id, action: 'create', entity: 'meetup', entity_id: String(id) },
    ]);
  });

  it('derives a unique slug for a second meetup with the same title and date', async () => {
    const admin = await signedIn();
    await admin.send('/api/admin/meetups', write('POST', VALID));

    const res = await admin.send('/api/admin/meetups', write('POST', VALID));

    expect(((await res.json()) as { slug: string }).slug).toBe('wednesday-walk-2026-10-07-2');
  });
});

describe('PATCH /api/admin/meetups/:id', () => {
  it('refuses an unknown zone even when no time is sent', async () => {
    const admin = await signedIn();
    const meetup = await seedMeetup(env.DB);

    const res = await admin.send(`/api/admin/meetups/${meetup.id}`, write('PATCH', { tz: 'Bad/Zone' }));

    expect(res.status).toBe(422);
    expect(paths((await res.json()) as ErrorBody)).toContain('tz');
    expect((await meetupRow(meetup.id))?.tz).toBe('America/Chicago');
  });

  it('keeps the stored zone when the body does not mention one', async () => {
    // `.partial()` keeps a zod default, so every PATCH without `tz` used to
    // reset the zone to Central.
    const admin = await signedIn();
    const meetup = await seedMeetup(env.DB, { tz: 'Asia/Tokyo' });

    const res = await admin.send(`/api/admin/meetups/${meetup.id}`, write('PATCH', { title: 'Renamed' }));

    expect(res.status).toBe(200);
    expect(await meetupRow(meetup.id)).toMatchObject({ title: 'Renamed', tz: 'Asia/Tokyo' });
  });

  it('refuses a javascript: Campfire link', async () => {
    const admin = await signedIn();
    const meetup = await seedMeetup(env.DB, { campfireUrl: 'https://example.com/ok' });

    const res = await admin.send(
      `/api/admin/meetups/${meetup.id}`,
      write('PATCH', { campfireUrl: 'JavaScript:alert(1)' }),
    );

    expect(res.status).toBe(422);
    expect((await meetupRow(meetup.id))?.campfire_url).toBe('https://example.com/ok');
  });

  it('refuses a POI that does not exist with 422, not a foreign-key 500', async () => {
    const admin = await signedIn();
    const meetup = await seedMeetup(env.DB);

    const res = await admin.send(`/api/admin/meetups/${meetup.id}`, write('PATCH', { poiId: 777 }));

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ detail: [{ path: 'poiId', message: 'does not exist' }] });
  });

  it('refuses a start that is not on the calendar', async () => {
    const admin = await signedIn();
    const meetup = await seedMeetup(env.DB);

    const res = await admin.send(
      `/api/admin/meetups/${meetup.id}`,
      write('PATCH', { startsAtLocal: '2026-04-31T18:00' }),
    );

    expect(res.status).toBe(422);
    expect((await meetupRow(meetup.id))?.starts_at).toBe(meetup.starts_at);
  });

  it('leaves omitted fields alone and clears an explicit null', async () => {
    const admin = await signedIn();
    const poi = await seedPoi(env.DB);
    const meetup = await seedMeetup(env.DB, {
      poiId: poi.id,
      locationText: 'By the pavilion',
      descriptionMd: 'Bring water',
      campfireUrl: 'https://example.com/rsvp',
    });

    const res = await admin.send(
      `/api/admin/meetups/${meetup.id}`,
      write('PATCH', { locationText: null, campfireUrl: '' }),
    );

    expect(res.status).toBe(200);
    expect(await meetupRow(meetup.id)).toMatchObject({
      poi_id: poi.id,
      description_md: 'Bring water',
      location_text: null,
      campfire_url: null,
    });
  });

  it('audits an update with the changed fields only', async () => {
    const admin = await signedIn();
    const meetup = await seedMeetup(env.DB, { title: 'Before' });

    await admin.send(`/api/admin/meetups/${meetup.id}`, write('PATCH', { title: 'After' }));

    const [row] = await auditRows();
    expect(row).toMatchObject({ actor_id: admin.user.id, action: 'update', entity_id: String(meetup.id) });
    expect(JSON.parse(row!.diff_json!)).toEqual({ title: { from: 'Before', to: 'After' } });
  });
});

describe('DELETE /api/admin/meetups/:id', () => {
  it('cancels by default, for an ambassador, and keeps the row', async () => {
    const ambassador = await signedIn('ambassador');
    const meetup = await seedMeetup(env.DB, { status: 'published' });

    const res = await ambassador.send(`/api/admin/meetups/${meetup.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect((await meetupRow(meetup.id))?.status).toBe('cancelled');
    expect(await auditRows()).toMatchObject([
      { actor_id: ambassador.user.id, action: 'archive', entity: 'meetup', entity_id: String(meetup.id) },
    ]);
  });

  it('refuses ?hard=1 to an ambassador', async () => {
    const ambassador = await signedIn('ambassador');
    const meetup = await seedMeetup(env.DB);

    const res = await ambassador.send(`/api/admin/meetups/${meetup.id}?hard=1`, { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Requires admin' });
    expect(await meetupRow(meetup.id)).not.toBeNull();
  });

  it('deletes for an admin with ?hard=1', async () => {
    const admin = await signedIn('admin');
    const meetup = await seedMeetup(env.DB);

    const res = await admin.send(`/api/admin/meetups/${meetup.id}?hard=1`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(await meetupRow(meetup.id)).toBeNull();
    expect(await auditRows()).toMatchObject([{ action: 'delete', entity: 'meetup' }]);
  });
});

describe('GET /api/admin/meetups', () => {
  it('states its cap and the true total, and is never cached', async () => {
    const admin = await signedIn();
    await seedMeetup(env.DB);

    const res = await admin.send('/api/admin/meetups');

    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ count: 1, total: 1, limit: 1000, truncated: false });
  });
});

describe('the announce flag', () => {
  it('queues a draft without sending, then announces once on publish', async () => {
    const webhook = mockWebhook();
    const admin = await signedIn();

    await withWebhook(async () => {
      const created = await admin.send(
        '/api/admin/meetups',
        write('POST', { ...VALID, status: 'draft', announce: true }),
      );
      const { id, announced } = (await created.json()) as { id: number; announced: string };
      expect(announced).toBe('queued');
      expect(webhook.calls).toHaveLength(0);
      expect((await meetupRow(id))?.announced_at).toBeNull();

      await admin.send(`/api/admin/meetups/${id}`, write('PATCH', { status: 'published' }));
      await expect.poll(() => webhook.calls.length, { timeout: 3000 }).toBe(1);
      await expect
        .poll(async () => (await meetupRow(id))?.announced_at, { timeout: 3000 })
        .not.toBeNull();

      await admin.send(`/api/admin/meetups/${id}`, write('PATCH', { title: 'Still on' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(webhook.calls).toHaveLength(1);
    });
  });
});

/* ------------------------------------------------- the pages that render it */

/** Every href on a page, so a test can say none of them is a script. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href\s*=\s*"([^"]*)"/gi)].map((m) => m[1]!);
}

describe('the public pages, given rows written before the checks existed', () => {
  it('renders / with a meetup whose stored zone Intl does not know', async () => {
    await seedZone(env.DB);
    await seedMeetup(env.DB, {
      title: 'Zone typo meetup',
      tz: 'Bad/Zone',
      startsAt: isoIn(86_400),
      status: 'published',
    });

    const res = await SELF.fetch(`${ORIGIN}/`);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Zone typo meetup');
  });

  it('renders no javascript: href on / or /events for a stored Campfire link', async () => {
    await seedZone(env.DB);
    await seedMeetup(env.DB, {
      title: 'Scripted meetup',
      startsAt: isoIn(86_400),
      status: 'published',
      campfireUrl: 'javascript:alert(document.cookie)',
    });

    for (const path of ['/', '/events']) {
      const res = await SELF.fetch(`${ORIGIN}${path}`);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain('Scripted meetup');
      expect(
        hrefs(html).filter((h) => /^\s*(javascript|data|vbscript):/i.test(h)),
        path,
      ).toEqual([]);
      expect(html.toLowerCase(), path).not.toContain('javascript:alert');
    }
  });

  it('still links a stored http(s) Campfire link', async () => {
    await seedZone(env.DB);
    await seedMeetup(env.DB, {
      startsAt: isoIn(86_400),
      status: 'published',
      campfireUrl: 'https://campfire.nianticlabs.com/discover/meetup/xyz',
    });

    const html = await (await SELF.fetch(`${ORIGIN}/events`)).text();

    expect(hrefs(html)).toContain('https://campfire.nianticlabs.com/discover/meetup/xyz');
  });
});
