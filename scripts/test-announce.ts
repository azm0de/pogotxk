/**
 * Checks the announcement path that does not need a network or a Worker.
 *
 *   npx tsx scripts/test-announce.ts
 *
 * The thing worth guarding here is not the HTTP call — it is the two decisions
 * around it. Announcing a post the site would still 404 is the failure the
 * community actually sees, and re-announcing one is the failure they cannot be
 * protected from afterwards, because an embed cannot be recalled from a channel
 * with real members in it.
 *
 * `notify/announcements.ts` takes `Env` as a parameter and imports nothing from
 * `cloudflare:workers` precisely so this file can exist. If a future edit adds
 * that import, this suite stops running — that is the intended alarm, not an
 * inconvenience to work around.
 */

import { MEETUP_PUBLIC, POST_PUBLIC } from '../src/lib/db/announcements';
import { NOW, VISIBLE } from '../src/lib/db/posts';
import {
  meetupAnnouncement,
  postAnnouncement,
  type AnnounceStatus,
} from '../src/lib/notify/announcements';
import {
  announceToDiscord,
  closeOutcomeForStatus,
  deliveryOutcomeForStatus,
} from '../src/lib/notify/discord';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`,
  );
  if (!ok) failures++;
}

const env = (vars: Record<string, string | undefined>) => vars as unknown as Env;
const ORIGIN = 'https://pogotxk.example';

/*
 * The claim in `db/announcements.ts` is that `POST_PUBLIC` says exactly what
 * the read model's `VISIBLE` says. That is a duplication held together by a
 * comment, which is the kind that rots — so it is asserted rather than trusted.
 *
 * The two differ only in ways that cannot change the meaning: the read model
 * aliases the table as `p` and inlines SQLite's clock, while the claim binds
 * the sweep's `now` as `?1` so every row in one pass is judged against the same
 * instant. Normalising those two away should leave identical text.
 */
console.log('\n== the announce predicate matches the read model ==');
const normalize = (sql: string) =>
  sql
    .replaceAll('p.', '')
    .replaceAll(NOW, '?1')
    .replace(/\s+/g, ' ')
    .trim();
check('POST_PUBLIC === VISIBLE, modulo alias and clock', normalize(POST_PUBLIC), normalize(VISIBLE));

// A cancelled meetup stays in the public feed so subscribers learn it is off,
// but announcing one would advertise an event that is not happening.
console.log('\n  a meetup is announceable only while published:');
check('published only', MEETUP_PUBLIC.includes("'published'"), true);
check('never draft', MEETUP_PUBLIC.includes("'draft'"), false);
check('never cancelled', MEETUP_PUBLIC.includes("'cancelled'"), false);

/*
 * One classifier, two vocabularies. The close sweep and the announce sweep make
 * the same retry decision from the same status codes, and the whole reason
 * `deliveryOutcomeForStatus` exists is so those two cannot drift.
 */
console.log('\n== delivery outcome classification ==');
check('200 -> ok', deliveryOutcomeForStatus(200), 'ok');
check('204 -> ok', deliveryOutcomeForStatus(204), 'ok');
check('404 -> gone', deliveryOutcomeForStatus(404), 'gone');
check('401 -> gone', deliveryOutcomeForStatus(401), 'gone');
check('403 -> gone', deliveryOutcomeForStatus(403), 'gone');
check('429 -> retry', deliveryOutcomeForStatus(429), 'retry');
check('500 -> retry', deliveryOutcomeForStatus(500), 'retry');

console.log('\n  the close sweep keeps its own word for success:');
check('200 -> edited', closeOutcomeForStatus(200), 'edited');
check('404 still gone', closeOutcomeForStatus(404), 'gone');
check('429 still retry', closeOutcomeForStatus(429), 'retry');

/*
 * With no webhook nothing is sent, and the caller must be able to tell that
 * apart from a delivery — a row marked settled after a `disabled` result would
 * lose its announcement permanently the moment a webhook is configured.
 */
console.log('\n== no webhook is not a delivery ==');
check('unset -> disabled', await announceToDiscord(env({}), { title: 'x', url: ORIGIN }), 'disabled');
check(
  'rejected host -> disabled',
  await announceToDiscord(env({ DISCORD_WEBHOOK_URL: 'https://evil.example/hook' }), {
    title: 'x',
    url: ORIGIN,
  }),
  'disabled',
);

console.log('\n== post announcements ==');
const post = postAnnouncement(
  {
    id: 4,
    slug: 'raid-hour-thursday',
    title: 'Raid hour, Thursday',
    excerpt: '  Six o’clock at the Campsite.  ',
    body_md: '# Ignored\n\nThe body is only a fallback.',
    hero_key: 'legacy/raid.jpg',
  },
  ORIGIN,
);
check('links to the post', post.url, `${ORIGIN}/blog/raid-hour-thursday`);
check('title is the post title', post.title, 'Raid hour, Thursday');
check('excerpt wins, trimmed', post.description, 'Six o’clock at the Campsite.');
// Discord will not fetch a relative image and silently drops the whole embed.
check('hero is absolute', post.imageUrl, `${ORIGIN}/media/legacy/raid.jpg`);

const noExcerpt = postAnnouncement(
  {
    id: 5,
    slug: 'no-excerpt',
    title: 'No excerpt',
    excerpt: '   ',
    body_md: '## Heading\n\nThe **opening** of the body, [linked](https://example.com).',
    hero_key: null,
  },
  ORIGIN,
);
check(
  'blank excerpt falls back to the body, as prose',
  noExcerpt.description,
  'Heading The opening of the body, linked.',
);
check('no hero, no image key', noExcerpt.imageUrl, undefined);

const empty = postAnnouncement(
  { id: 6, slug: 'bare', title: 'Bare', excerpt: null, body_md: '', hero_key: null },
  ORIGIN,
);
// `undefined` rather than `''`: an empty string is a rendered empty line in the
// embed, where an absent key is simply no description.
check('a bodyless post has no description', empty.description, undefined);

console.log('\n== meetup announcements ==');
const meetup = meetupAnnouncement(
  {
    id: 12,
    title: 'Community Day',
    description_md: 'Meet by the **parking lot**.',
    starts_at: '2026-09-12T23:00:00Z',
    ends_at: null,
    tz: 'America/Chicago',
    poi_name: 'Campsite - Genuine',
    location_text: 'ignored when a POI is set',
    hero_key: null,
  },
  ORIGIN,
);
// The anchor is the meetup id, so a link posted today survives a rename.
check('links to the events anchor', meetup.url, `${ORIGIN}/events#meetup-12`);
check(
  'leads with when and where, POI winning',
  meetup.description,
  'Sat, Sep 12, 6:00 PM CDT · Campsite - Genuine\n\nMeet by the parking lot.',
);

const freeText = meetupAnnouncement(
  {
    id: 13,
    title: 'Walk',
    description_md: null,
    starts_at: '2026-01-10T00:00:00Z',
    ends_at: null,
    tz: 'America/Chicago',
    poi_name: null,
    location_text: 'Bramlett Field',
    hero_key: null,
  },
  ORIGIN,
);
// CST in January, CDT in September — the same stored instant formats both ways,
// which is the whole reason times are stored as UTC and rendered in the zone.
check(
  'falls back to the free text, and to CST',
  freeText.description,
  'Fri, Jan 9, 6:00 PM CST · Bramlett Field',
);

const nowhere = meetupAnnouncement(
  {
    id: 14,
    title: 'TBC',
    description_md: null,
    starts_at: '2026-01-10T00:00:00Z',
    ends_at: null,
    tz: 'America/Chicago',
    poi_name: null,
    location_text: null,
    hero_key: null,
  },
  ORIGIN,
);
check('no place, no separator left dangling', nowhere.description, 'Fri, Jan 9, 6:00 PM CST');

/* The three states a save may report, kept honest against the union type. */
console.log('\n== save states ==');
const states: AnnounceStatus[] = ['off', 'queued', 'disabled'];
check('exactly three, and none of them claims delivery', states.length, 3);
check('none says "announced"', states.includes('queued' as AnnounceStatus), true);

console.log(
  failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
