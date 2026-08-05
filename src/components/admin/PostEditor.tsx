import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { AdminPost, PostStatus } from '~/lib/db/posts';
import { renderMarkdown } from '~/lib/markdown';
import { slugify } from '~/lib/slug';
import { DEFAULT_TZ, formatInZone, utcToZoned } from '~/lib/time';
import './PostEditor.css';

interface MediaOption {
  id: number;
  r2_key: string;
  alt: string | null;
  kind: string;
}

interface Form {
  title: string;
  slug: string;
  excerpt: string;
  bodyMd: string;
  status: PostStatus;
  pinned: boolean;
  tags: string[];
  heroMediaId: number | null;
  publishedAtLocal: string;
}

const EMPTY: Form = {
  title: '',
  slug: '',
  excerpt: '',
  bodyMd: '',
  status: 'draft',
  pinned: false,
  tags: [],
  heroMediaId: null,
  publishedAtLocal: '',
};

type PaneMode = 'write' | 'split' | 'preview';

const STATUS_FILTERS = ['all', 'draft', 'scheduled', 'published', 'archived'] as const;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    // Astro rejects cross-site POSTs without a JSON content-type.
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: unknown };
    const detail = Array.isArray(body.detail)
      ? ` — ${(body.detail as { path: string; message: string }[])
          .map((d) => `${d.path}: ${d.message}`)
          .join(', ')}`
      : '';
    throw new Error(`${body.error ?? res.statusText}${detail}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * What a reader would see right now. A `scheduled` post whose time has passed
 * is already public — the read model decides that per query — so the console
 * says "Live" rather than leaving an author wondering why nothing published.
 */
function publicState(post: AdminPost): 'draft' | 'scheduled' | 'live' | 'archived' {
  if (post.status === 'draft') return 'draft';
  if (post.status === 'archived') return 'archived';
  if (!post.publishedAt) return post.status === 'published' ? 'live' : 'scheduled';
  return post.publishedAt <= nowIso() ? 'live' : 'scheduled';
}

/** Local wall-clock string for `<input type="datetime-local">`, tomorrow at 6 PM. */
function defaultScheduleTime(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}T18:00`;
}

export default function PostEditor() {
  const [posts, setPosts] = useState<AdminPost[]>([]);
  const [media, setMedia] = useState<MediaOption[]>([]);
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [slugTouched, setSlugTouched] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [pane, setPane] = useState<PaneMode>('split');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    setMessage({ kind, text });
    window.setTimeout(() => setMessage(null), kind === 'ok' ? 2600 : 7000);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([
        api<{ posts: AdminPost[] }>('/api/admin/posts'),
        api<{ media: MediaOption[] }>('/api/admin/media?limit=200'),
      ]);
      setPosts(p.posts);
      setMedia(m.media);
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not load posts');
    }
  }, [notify]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const startNew = () => {
    setForm(EMPTY);
    setSlugTouched(false);
    setTagDraft('');
    setEditingId('new');
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const startEdit = (post: AdminPost) => {
    setForm({
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt ?? '',
      bodyMd: post.bodyMd,
      status: post.status,
      pinned: post.pinned,
      tags: post.tags,
      heroMediaId: post.heroMediaId,
      publishedAtLocal: post.publishedAt ? utcToZoned(post.publishedAt) : '',
    });
    // An existing post already has a URL; never rewrite it from the title.
    setSlugTouched(true);
    setTagDraft('');
    setEditingId(post.id);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const onTitle = (value: string) => {
    setForm((f) => ({ ...f, title: value, slug: slugTouched ? f.slug : slugify(value) }));
  };

  const onStatus = (value: PostStatus) => {
    setForm((f) => ({
      ...f,
      status: value,
      // Picking "scheduled" with no date is almost always a half-finished
      // thought; offer tomorrow evening rather than an empty required field.
      publishedAtLocal:
        value === 'scheduled' && !f.publishedAtLocal ? defaultScheduleTime() : f.publishedAtLocal,
    }));
  };

  const addTag = (raw: string) => {
    const tag = slugify(raw).slice(0, 40);
    if (!tag || tag === 'item') return;
    setForm((f) => (f.tags.includes(tag) ? f : { ...f, tags: [...f.tags, tag].slice(0, 12) }));
    setTagDraft('');
  };

  const onTagKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagDraft);
    } else if (e.key === 'Backspace' && !tagDraft && form.tags.length) {
      setForm((f) => ({ ...f, tags: f.tags.slice(0, -1) }));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = {
        title: form.title,
        slug: form.slug || undefined,
        excerpt: form.excerpt || null,
        bodyMd: form.bodyMd,
        status: form.status,
        pinned: form.pinned,
        tags: form.tags,
        heroMediaId: form.heroMediaId,
        publishedAtLocal: form.publishedAtLocal || null,
        tz: DEFAULT_TZ,
      };

      if (editingId === 'new') {
        const created = await api<{ id: number }>('/api/admin/posts', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        notify('ok', 'Post created');
        setEditingId(created.id);
      } else {
        await api(`/api/admin/posts/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        notify('ok', 'Post saved');
      }
      await reload();
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (post: AdminPost) => {
    if (!window.confirm(`Delete “${post.title}”? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api(`/api/admin/posts/${post.id}`, { method: 'DELETE' });
      if (editingId === post.id) setEditingId(null);
      await reload();
      notify('ok', 'Deleted');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not delete');
    } finally {
      setBusy(false);
    }
  };

  // Rendering 20 KB of Markdown on every keystroke would make typing stutter;
  // `useDeferredValue` lets React keep the textarea responsive and catch the
  // preview up when it has a moment.
  const deferredBody = useDeferredValue(form.bodyMd);
  const previewHtml = useMemo(() => renderMarkdown(deferredBody), [deferredBody]);
  const previewStale = deferredBody !== form.bodyMd;

  const visible = useMemo(
    () => (filter === 'all' ? posts : posts.filter((p) => p.status === filter)),
    [posts, filter],
  );

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: posts.length };
    for (const p of posts) out[p.status] = (out[p.status] ?? 0) + 1;
    return out;
  }, [posts]);

  return (
    <div className="posts">
      <header className="posts-head">
        <div>
          <h1>News</h1>
          <p>
            Posts are Markdown. A <strong>scheduled</strong> post goes live on its own at the time
            below — nothing needs deploying.
          </p>
        </div>
        <button type="button" className="btn" onClick={startNew}>
          + New post
        </button>
      </header>

      <p className={`posts-toast${message ? ` posts-toast--${message.kind}` : ''}`} role="status" aria-live="polite">
        {message?.text ?? ''}
      </p>

      {editingId !== null && (
        <form className="post-form" onSubmit={submit} ref={formRef}>
          <div className="post-form-head">
            <h2>{editingId === 'new' ? 'New post' : 'Edit post'}</h2>
            {editingId !== 'new' && form.slug && (
              <a
                className="post-form-view"
                href={`/blog/${form.slug}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on site ↗
              </a>
            )}
          </div>

          <label>
            <span>Title</span>
            <input
              value={form.title}
              onChange={(e) => onTitle(e.target.value)}
              placeholder="e.g. August Community Day recap"
              required
              maxLength={200}
            />
          </label>

          <div className="form-grid">
            <label>
              <span>Slug (the URL)</span>
              <input
                value={form.slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  set('slug', e.target.value);
                }}
                placeholder="august-community-day-recap"
                maxLength={200}
              />
            </label>
            <label>
              <span>Hero image</span>
              <select
                value={form.heroMediaId ?? ''}
                onChange={(e) => set('heroMediaId', e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— none —</option>
                {media.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.alt || m.r2_key}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label>
            <span>Excerpt — the card blurb and meta description (optional)</span>
            <textarea
              rows={2}
              value={form.excerpt}
              onChange={(e) => set('excerpt', e.target.value)}
              placeholder="Left blank, the first couple of lines of the post are used."
              maxLength={400}
            />
          </label>

          <div className="form-grid">
            <label>
              <span>Status</span>
              <select
                value={form.status}
                onChange={(e) => onStatus(e.target.value as PostStatus)}
              >
                <option value="draft">Draft — not public</option>
                <option value="scheduled">Scheduled — public at the time below</option>
                <option value="published">Published</option>
                <option value="archived">Archived — hidden</option>
              </select>
            </label>
            <label>
              {/* Labelled "Central", not "America/Chicago" — the zone id is an
                  implementation detail nobody in Texarkana thinks in. */}
              <span>Publish time (Central)</span>
              <input
                type="datetime-local"
                value={form.publishedAtLocal}
                onChange={(e) => set('publishedAtLocal', e.target.value)}
              />
            </label>
          </div>

          {form.status === 'published' && !form.publishedAtLocal && (
            <p className="form-note">Saving with no time set stamps this post as published now.</p>
          )}
          {form.status === 'scheduled' && form.publishedAtLocal && (
            <p className="form-note">
              Goes live at{' '}
              <strong>
                {formatInZone(new Date(`${form.publishedAtLocal}:00Z`).toISOString(), 'UTC').replace(
                  ' UTC',
                  '',
                )}
              </strong>{' '}
              Central. The site works out CST vs CDT itself.
            </p>
          )}

          <div className="form-grid">
            <div className="tag-field">
              <label htmlFor="post-tag-input">
                <span>Tags</span>
              </label>
              <div className="tag-input">
                {form.tags.map((tag) => (
                  <span className="tag-chip" key={tag}>
                    {tag}
                    <button
                      type="button"
                      aria-label={`Remove tag ${tag}`}
                      onClick={() => set('tags', form.tags.filter((t) => t !== tag))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  id="post-tag-input"
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={onTagKey}
                  onBlur={() => addTag(tagDraft)}
                  placeholder={form.tags.length ? '' : 'raids, community-day…'}
                  maxLength={60}
                />
              </div>
            </div>

            <div className="pin-field">
              <span className="pin-label">Placement</span>
              <button
                type="button"
                className="pin-toggle"
                aria-pressed={form.pinned}
                onClick={() => set('pinned', !form.pinned)}
              >
                <span aria-hidden="true">{form.pinned ? '★' : '☆'}</span>
                {form.pinned ? 'Pinned to the top' : 'Pin to the top'}
              </button>
            </div>
          </div>

          <div className="body-head">
            <span className="body-label">Body (Markdown)</span>
            <div className="pane-switch" role="group" aria-label="Editor layout">
              {(['write', 'split', 'preview'] as PaneMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={pane === mode}
                  onClick={() => setPane(mode)}
                >
                  {mode[0]?.toUpperCase()}
                  {mode.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className={`body-panes body-panes--${pane}`}>
            {pane !== 'preview' && (
              <textarea
                className="body-input"
                value={form.bodyMd}
                onChange={(e) => set('bodyMd', e.target.value)}
                placeholder={'## What happened\n\nWe had **42 trainers** turn out…'}
                spellCheck
                aria-label="Post body, Markdown"
              />
            )}
            {pane !== 'write' && (
              <div
                className={`body-preview${previewStale ? ' is-stale' : ''}`}
                aria-live="off"
                // Safe by construction: renderMarkdown escapes the source before
                // it emits a single tag, so nothing an author types can become
                // markup. See src/lib/markdown.ts.
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            )}
          </div>

          <div className="form-actions">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Saving…' : editingId === 'new' ? 'Create post' : 'Save changes'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setEditingId(null)}
              disabled={busy}
            >
              Close
            </button>
          </div>
        </form>
      )}

      <div className="posts-filters" role="group" aria-label="Filter by status">
        {STATUS_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === 'all' ? 'All' : value[0]?.toUpperCase() + value.slice(1)}
            <span className="filter-count">{counts[value] ?? 0}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="posts-empty">Nothing here yet. Create a post above.</p>
      ) : (
        <ul className="post-list">
          {visible.map((post) => {
            const state = publicState(post);
            return (
              <li key={post.id} className="post-row">
                <div className="post-row-main">
                  <h3>
                    {post.pinned && (
                      <span className="post-row-pin" title="Pinned" aria-label="Pinned">
                        ★
                      </span>
                    )}
                    {post.title}
                  </h3>
                  <p>
                    <code>/blog/{post.slug}</code>
                    {post.tags.length > 0 && <span className="post-row-tags">{post.tags.map((t) => `#${t}`).join(' ')}</span>}
                  </p>
                </div>

                <div className="post-row-when">
                  {post.publishedAt ? formatInZone(post.publishedAt) : 'No date'}
                </div>

                <span className={`post-state post-state--${state}`}>{state}</span>

                <div className="post-row-actions">
                  <button type="button" onClick={() => startEdit(post)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void remove(post)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
