/**
 * What the post routes do once a caller is through the gate.
 *
 * `api-matrix.test.ts` proves who may call each route and nothing else — its
 * bodies are deliberately valid, so a route that saved the wrong thing would
 * pass it. This file is the other half: validation, partial updates, slugs,
 * tags, the audit trail, archive-versus-delete, and the Discord announcement
 * flag, each asserted against the rows the route actually wrote.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedMedia, seedPost } from '../helpers/factories';
import { mockWebhook, withWebhook } from '../flares/harness';
import {
  auditRows,
  rowCount,
  signedIn,
  withFailingAudit,
  write,
  type ErrorBody,
} from './surface';

interface PostRow {
  id: number;
  slug: string;
  title: string;
  excerpt: string | null;
  body_md: string;
  hero_media_id: number | null;
  status: string;
  pinned: number;
  published_at: string | null;
  announce_requested: number;
  announced_at: string | null;
}

async function postRow(id: number): Promise<PostRow | null> {
  return env.DB.prepare('SELECT * FROM posts WHERE id = ?1').bind(id).first<PostRow>();
}

async function tagsOf(id: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT tag FROM post_tags WHERE post_id = ?1 ORDER BY tag',
  )
    .bind(id)
    .all<{ tag: string }>();
  return results.map((r) => r.tag);
}

function paths(body: ErrorBody): string[] {
  return (body.detail as { path: string }[]).map((d) => d.path);
}

describe('POST /api/admin/posts — validation', () => {
  it.each([
    ['an empty title', { title: '   ' }, 'title'],
    ['an oversize title', { title: 'x'.repeat(201) }, 'title'],
    ['an oversize excerpt', { title: 'Fine', excerpt: 'x'.repeat(401) }, 'excerpt'],
    ['a status outside the enum', { title: 'Fine', status: 'live' }, 'status'],
    ['too many tags', { title: 'Fine', tags: Array.from({ length: 13 }, (_, i) => `t${i}`) }, 'tags'],
    ['an unknown time zone', { title: 'Fine', tz: 'Bad/Zone' }, 'tz'],
  ])('refuses %s with 422 and writes nothing', async (_label, body, field) => {
    const admin = await signedIn();

    const res = await admin.send('/api/admin/posts', write('POST', body));

    expect(res.status).toBe(422);
    const json = (await res.json()) as ErrorBody;
    expect(json.error).toBe('Validation failed');
    expect(paths(json)).toContain(field);
    expect(await rowCount('posts')).toBe(0);
    expect(await rowCount('audit_log')).toBe(0);
  });

  it('refuses a publish time that is not on the calendar', async () => {
    const admin = await signedIn();

    const res = await admin.send(
      '/api/admin/posts',
      write('POST', { title: 'Typo', status: 'scheduled', publishedAtLocal: '2026-02-30T18:00' }),
    );

    expect(res.status).toBe(422);
    expect(await rowCount('posts')).toBe(0);
  });

  it('refuses a hero image that does not exist, naming the field', async () => {
    const admin = await signedIn();

    const res = await admin.send('/api/admin/posts', write('POST', { title: 'Hero', heroMediaId: 999 }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Validation failed',
      detail: [{ path: 'heroMediaId', message: 'does not exist' }],
    });
    expect(await rowCount('posts')).toBe(0);
  });
});

describe('POST /api/admin/posts — what it writes', () => {
  it('derives a unique slug when the title is already taken', async () => {
    const admin = await signedIn();
    await seedPost(env.DB, { slug: 'raid-hour' });

    const res = await admin.send('/api/admin/posts', write('POST', { title: 'Raid Hour' }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; slug: string };
    expect(body.slug).toBe('raid-hour-2');
    expect((await postRow(body.id))?.slug).toBe('raid-hour-2');
  });

  it('normalises tags through the route, the same way the client does', async () => {
    const admin = await signedIn();

    const res = await admin.send(
      '/api/admin/posts',
      write('POST', { title: 'Tagged', tags: ['Raid Hour', 'raid-hour', '  Pokémon  ', '!!!'] }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; tags: string[] };
    expect(body.tags).toEqual(['pokemon', 'raid-hour']);
    expect(await tagsOf(body.id)).toEqual(['pokemon', 'raid-hour']);
  });

  it('writes one create audit row naming the actor and the new id', async () => {
    const admin = await signedIn();

    const res = await admin.send('/api/admin/posts', write('POST', { title: 'Audited' }));
    const { id } = (await res.json()) as { id: number };

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: admin.user.id,
      action: 'create',
      entity: 'post',
      entity_id: String(id),
    });
  });

  it('commits nothing when the audit row cannot be written', async () => {
    const admin = await signedIn();

    const res = await withFailingAudit(() =>
      admin.send('/api/admin/posts', write('POST', { title: 'Half done', tags: ['raids'] })),
    );

    // The row, its tags and its audit entry are one transaction (B-15).
    expect(res.status).toBe(500);
    expect(await rowCount('posts')).toBe(0);
    expect(await rowCount('post_tags')).toBe(0);
  });
});

describe('PATCH /api/admin/posts/:id', () => {
  it('leaves omitted fields untouched', async () => {
    const admin = await signedIn();
    const post = await seedPost(env.DB, {
      title: 'Original',
      excerpt: 'Kept',
      bodyMd: 'Body kept',
      pinned: true,
    });

    const res = await admin.send(`/api/admin/posts/${post.id}`, write('PATCH', { title: 'Renamed' }));

    expect(res.status).toBe(200);
    const row = await postRow(post.id);
    expect(row).toMatchObject({
      title: 'Renamed',
      excerpt: 'Kept',
      body_md: 'Body kept',
      pinned: 1,
      // A title edit never moves the permanent URL.
      slug: post.slug,
    });
  });

  it('clears a nullable field sent as an explicit null', async () => {
    const admin = await signedIn();
    const media = await seedMedia(env.DB);
    const post = await seedPost(env.DB, { excerpt: 'Going', heroMediaId: media.id });

    const res = await admin.send(
      `/api/admin/posts/${post.id}`,
      write('PATCH', { excerpt: null, heroMediaId: null }),
    );

    expect(res.status).toBe(200);
    const row = await postRow(post.id);
    expect(row?.excerpt).toBeNull();
    expect(row?.hero_media_id).toBeNull();
  });

  it('refuses a hero image that does not exist with 422, not a foreign-key 500', async () => {
    const admin = await signedIn();
    const post = await seedPost(env.DB);

    const res = await admin.send(`/api/admin/posts/${post.id}`, write('PATCH', { heroMediaId: 404 }));

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      detail: [{ path: 'heroMediaId', message: 'does not exist' }],
    });
    expect((await postRow(post.id))?.hero_media_id).toBeNull();
  });

  it('replaces tags and records the change in the same audit row', async () => {
    const admin = await signedIn();
    const post = await seedPost(env.DB);
    await env.DB.prepare("INSERT INTO post_tags (post_id, tag) VALUES (?1, 'old')").bind(post.id).run();

    const res = await admin.send(`/api/admin/posts/${post.id}`, write('PATCH', { tags: ['New Tag'] }));

    expect(res.status).toBe(200);
    expect(await tagsOf(post.id)).toEqual(['new-tag']);
    const [row] = await auditRows();
    expect(row).toMatchObject({ actor_id: admin.user.id, action: 'update', entity: 'post' });
    expect(JSON.parse(row!.diff_json!).tags).toEqual({ from: ['old'], to: ['new-tag'] });
  });

  it('writes no audit row for a save that changed nothing', async () => {
    const admin = await signedIn();
    const post = await seedPost(env.DB, { title: 'Same' });

    const res = await admin.send(`/api/admin/posts/${post.id}`, write('PATCH', { title: 'Same' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: false });
    expect(await rowCount('audit_log')).toBe(0);
  });

  it('leaves the row as it was when the audit row cannot be written', async () => {
    const admin = await signedIn();
    const post = await seedPost(env.DB, { title: 'Before' });
    await env.DB.prepare("INSERT INTO post_tags (post_id, tag) VALUES (?1, 'kept')").bind(post.id).run();

    const res = await withFailingAudit(() =>
      admin.send(`/api/admin/posts/${post.id}`, write('PATCH', { title: 'After', tags: ['gone'] })),
    );

    expect(res.status).toBe(500);
    expect((await postRow(post.id))?.title).toBe('Before');
    expect(await tagsOf(post.id)).toEqual(['kept']);
  });
});

describe('DELETE /api/admin/posts/:id', () => {
  it('archives by default, for an ambassador, and keeps the row and its tags', async () => {
    const ambassador = await signedIn('ambassador');
    const post = await seedPost(env.DB, { status: 'published' });
    await env.DB.prepare("INSERT INTO post_tags (post_id, tag) VALUES (?1, 'raids')").bind(post.id).run();

    const res = await ambassador.send(`/api/admin/posts/${post.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect((await postRow(post.id))?.status).toBe('archived');
    expect(await tagsOf(post.id)).toEqual(['raids']);
    expect(await auditRows()).toMatchObject([
      { actor_id: ambassador.user.id, action: 'archive', entity: 'post', entity_id: String(post.id) },
    ]);
  });

  it('refuses ?hard=1 to an ambassador and leaves the post alone', async () => {
    const ambassador = await signedIn('ambassador');
    const post = await seedPost(env.DB);

    const res = await ambassador.send(`/api/admin/posts/${post.id}?hard=1`, { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Requires admin' });
    expect(await postRow(post.id)).not.toBeNull();
    expect(await rowCount('audit_log')).toBe(0);
  });

  it('deletes for an admin with ?hard=1, and the tags go with it', async () => {
    const admin = await signedIn('admin');
    const post = await seedPost(env.DB);
    await env.DB.prepare("INSERT INTO post_tags (post_id, tag) VALUES (?1, 'raids')").bind(post.id).run();

    const res = await admin.send(`/api/admin/posts/${post.id}?hard=1`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(await postRow(post.id)).toBeNull();
    expect(await rowCount('post_tags')).toBe(0);
    expect(await auditRows()).toMatchObject([
      { actor_id: admin.user.id, action: 'delete', entity: 'post', entity_id: String(post.id) },
    ]);
  });

  it('answers 404 for a post that does not exist', async () => {
    const admin = await signedIn();
    const res = await admin.send('/api/admin/posts/9999', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/posts', () => {
  it('states its cap and the true total, and is never cached', async () => {
    const admin = await signedIn();
    await seedPost(env.DB);
    await seedPost(env.DB);

    const res = await admin.send('/api/admin/posts');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ count: 2, total: 2, limit: 200, truncated: false });
  });
});

describe('the announce flag', () => {
  it('is off when nobody asked', async () => {
    const admin = await signedIn();
    const res = await admin.send('/api/admin/posts', write('POST', { title: 'Quiet' }));
    expect(await res.json()).toMatchObject({ announced: 'off' });
  });

  it('says disabled, and keeps the request, when no webhook is configured', async () => {
    const admin = await signedIn();
    const res = await admin.send(
      '/api/admin/posts',
      write('POST', { title: 'Loud', status: 'published', announce: true }),
    );
    const { id, announced } = (await res.json()) as { id: number; announced: string };

    expect(announced).toBe('disabled');
    const row = await postRow(id);
    expect(row?.announce_requested).toBe(1);
    expect(row?.announced_at).toBeNull();
  });

  it('queues a draft without sending, then announces once on publish, and never again', async () => {
    const webhook = mockWebhook();
    const admin = await signedIn();

    await withWebhook(async () => {
      const created = await admin.send(
        '/api/admin/posts',
        write('POST', { title: 'Coming soon', status: 'draft', announce: true }),
      );
      const { id, announced } = (await created.json()) as { id: number; announced: string };

      // A draft is not public, so it records the request and sends nothing.
      expect(announced).toBe('queued');
      expect((await postRow(id))?.announced_at).toBeNull();
      expect(webhook.calls).toHaveLength(0);

      const published = await admin.send(
        `/api/admin/posts/${id}`,
        write('PATCH', { status: 'published' }),
      );
      expect(await published.json()).toMatchObject({ announced: 'queued' });

      // The send rides waitUntil, so it lands after the response.
      await expect.poll(() => webhook.calls.length, { timeout: 3000 }).toBe(1);
      await expect.poll(async () => (await postRow(id))?.announced_at, { timeout: 3000 }).not.toBeNull();
      const settledAt = (await postRow(id))?.announced_at;

      // Saving again — even re-ticking the box — sends nothing and moves nothing.
      await admin.send(`/api/admin/posts/${id}`, write('PATCH', { title: 'Here now', announce: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(webhook.calls).toHaveLength(1);
      expect((await postRow(id))?.announced_at).toBe(settledAt);
    });
  });
});
