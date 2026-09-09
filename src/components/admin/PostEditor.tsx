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
  /** "Also announce to Discord" — a request; see notify/announcements.ts. */
  announce: boolean;
  /**
   * When the announcement was actually sent, or null while it is still owed.
   * Never edited here — it is what turns the toggle into a statement of fact
   * rather than an offer, so an author cannot ask twice for the same embed.
   */
  announcedAt: string | null;
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
  announce: false,
  announcedAt: null,
};

type PaneMode = 'write' | 'split' | 'preview';

const STATUS_FILTERS = ['all', 'draft', 'scheduled', 'published', 'archived'] as const;

/**
 * The badge each public state wears. One vocabulary across the console: red is
 * "now" and nothing else, an outline is "committed but not yet", muted is over.
 * The word is printed in every case — colour is never the only signal.
 */
const STATE_BADGE: Record<'draft' | 'scheduled' | 'live' | 'archived', string> = {
  draft: '',
  scheduled: 'badge--outline',
  live: 'badge--live',
  archived: 'badge--retired',
};

/** The Campsite/pinned star, from the same path the map pin's badge uses. */
function StarIcon({ filled }: { filled: boolean }) {
  const d = 'M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z';
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d={d}
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A drawn megaphone, for the announce toggle. Same vocabulary as the star. */
function AnnounceIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4 9v6h3l7 4V5L7 9H4z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 2}
        strokeLinejoin="round"
      />
      <path
        d="M17.5 8.5a5 5 0 010 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A drawn remove mark; the world does not use glyphs as icons. */
function RemoveIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M6 6l12 12M18 6L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * What a save says about the announcement, mirroring the server's three states.
 * Deliberately never claims the embed has landed — the send is handed to
 * `waitUntil`, exactly as the flare fan-out is, so the save cannot know.
 */
type AnnounceStatus = 'off' | 'queued' | 'disabled';

interface Saved {
  announced: AnnounceStatus;
}

function announceSuffix(status: AnnounceStatus): string {
  if (status === 'queued') return ' · announcing to Discord';
  // Worth saying out loud rather than failing quietly: the author ticked the
  // box and nothing is going to happen until a webhook exists. The request is
  // kept, so it will go out once one does.
  if (status === 'disabled') return ' · no Discord webhook is configured';
  return '';
}

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
  /** True while a post's body is being fetched for the editor. */
  const [bodyLoading, setBodyLoading] = useState(false);
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

  /**
   * Opens a post for editing.
   *
   * The body is fetched here rather than read off the list row: the list query
   * deliberately does not select `body_md`, because hauling every post body to
   * render a list of titles is a multi-megabyte response once there is a year
   * of them. Populating the form from the list row would put an empty string in
   * the textarea and destroy the post on save.
   */
  const startEdit = async (post: AdminPost) => {
    setEditingId(post.id);
    setSlugTouched(true); // An existing post has a URL; never rewrite it from the title.
    setTagDraft('');
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    setForm({
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt ?? '',
      bodyMd: '',
      status: post.status,
      pinned: post.pinned,
      tags: post.tags,
      heroMediaId: post.heroMediaId,
      publishedAtLocal: post.publishedAt ? utcToZoned(post.publishedAt) : '',
      announce: post.announce,
      announcedAt: post.announcedAt,
    });

    setBodyLoading(true);
    try {
      const { post: full } = await api<{ post: AdminPost }>(`/api/admin/posts/${post.id}`);
      // Guard against a slow response landing after the user opened another
      // post — otherwise this would drop one post's body into another's form.
      setEditingId((current) => {
        if (current === post.id) setForm((f) => ({ ...f, bodyMd: full.bodyMd }));
        return current;
      });
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not load the post body');
      // Leave edit mode rather than offer an empty textarea that would wipe it.
      setEditingId(null);
    } finally {
      setBodyLoading(false);
    }
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
        announce: form.announce,
      };

      let announced: AnnounceStatus = 'off';
      if (editingId === 'new') {
        const created = await api<Saved & { id: number }>('/api/admin/posts', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        announced = created.announced;
        notify('ok', `Post created${announceSuffix(announced)}`);
        setEditingId(created.id);
      } else {
        const saved = await api<Saved>(`/api/admin/posts/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        announced = saved.announced;
        notify('ok', `Post saved${announceSuffix(announced)}`);
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
    <div className="posts admin-page admin-page--wide">
      <header className="posts-head">
        <div>
          <h1>News</h1>
          <p>
            Posts are Markdown. A <strong>scheduled</strong> post goes live on its own at the time
            below — nothing needs deploying.
          </p>
        </div>
        <button type="button" className="btn btn--primary" onClick={startNew}>
          New post
        </button>
      </header>

      <p className={`posts-toast${message ? ` posts-toast--${message.kind}` : ''}`} role="status" aria-live="polite">
        {message?.text ?? ''}
      </p>

      {editingId !== null && (
        <form className="post-form panel admin-form" onSubmit={submit} ref={formRef}>
          <div className="post-form-head">
            <h2>{editingId === 'new' ? 'New post' : 'Edit post'}</h2>
            {editingId !== 'new' && form.slug && (
              <a
                className="btn btn--outline btn--sm btn--arrow"
                href={`/blog/${form.slug}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on site
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
                      <RemoveIcon />
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
                className="btn pin-toggle"
                aria-pressed={form.pinned}
                onClick={() => set('pinned', !form.pinned)}
              >
                <StarIcon filled={form.pinned} />
                {form.pinned ? 'Pinned to the top' : 'Pin to the top'}
              </button>
            </div>

            {/*
              Announcing is a one-way door — an embed cannot be recalled from a
              channel with real members in it — so once it has been sent this
              stops being a control and becomes a statement. Untickable, and it
              says when. Before that it is an ordinary toggle: the message goes
              out when the post is public, which for a scheduled post is later.
            */}
            <div className="pin-field">
              <span className="pin-label">Discord</span>
              {form.announcedAt ? (
                <p className="announce-done">
                  <AnnounceIcon filled />
                  Announced {formatInZone(form.announcedAt, DEFAULT_TZ)}
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn pin-toggle"
                    aria-pressed={form.announce}
                    aria-describedby="announce-note"
                    onClick={() => set('announce', !form.announce)}
                  >
                    <AnnounceIcon filled={form.announce} />
                    {form.announce ? 'Announcing to Discord' : 'Also announce to Discord'}
                  </button>
                  <p className="announce-note" id="announce-note">
                    {form.announce
                      ? form.status === 'draft'
                        ? 'Nothing is sent while this is a draft.'
                        : form.status === 'scheduled'
                          ? 'Sent once the publish time passes and someone loads the site.'
                          : 'Sent once, when you save.'
                      : 'Posts are not announced unless you ask.'}
                  </p>
                </>
              )}
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
                /* The body arrives a moment after the rest of the form — the
                   list query does not carry it. Typing into the textarea before
                   it lands would be typing into something about to be replaced. */
                readOnly={bodyLoading}
                placeholder={
                  bodyLoading
                    ? 'Loading the post…'
                    : '## What happened\n\nWe had **42 trainers** turn out…'
                }
                spellCheck
                aria-label="Post body, Markdown"
              />
            )}
            {pane !== 'write' && (
              <div
                className={`body-preview prose${previewStale ? ' is-stale' : ''}`}
                aria-live="off"
                // Safe by construction: renderMarkdown escapes the source before
                // it emits a single tag, so nothing an author types can become
                // markup. See src/lib/markdown.ts.
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            )}
          </div>

          <div className="form-actions">
            {/* Saving mid-fetch would write the empty placeholder body over
                the real one. */}
            <button type="submit" className="btn btn--primary" disabled={busy || bodyLoading}>
              {busy ? 'Saving…' : editingId === 'new' ? 'Create post' : 'Save changes'}
            </button>
            <button
              type="button"
              className="btn btn--outline"
              onClick={() => setEditingId(null)}
              disabled={busy}
            >
              Close
            </button>
          </div>
        </form>
      )}

      {/*
        The list is a section with its own heading, the way the meetup editor's
        Upcoming/Past lists are.

        Not decoration: the row titles below are `h3`, and the only `h2` on this
        page lives inside the editor form — which is rendered only while
        something is being edited. So the resting state of the page ran h1
        straight to h3, and a screen reader arrived at a stack of post titles
        with nothing having said what the list was. No count here, unlike the
        meetup sections: the filter chips directly beneath carry one each, and
        the active one already reports exactly this number.
      */}
      <section aria-labelledby="posts-list-heading">
      <h2 id="posts-list-heading" className="posts-list-heading">Posts</h2>

      <div className="posts-filters" role="group" aria-label="Filter by status">
        {STATUS_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            className="chip"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === 'all' ? 'All' : value[0]?.toUpperCase() + value.slice(1)}
            <span className="filter-count">{counts[value] ?? 0}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="empty-state">Nothing here yet. Create a post above.</p>
      ) : (
        <ul className="admin-rows">
          {visible.map((post) => {
            const state = publicState(post);
            return (
              <li key={post.id} className="card admin-row">
                <div className="admin-row-main">
                  <h3>
                    {post.pinned && (
                      <>
                        <StarIcon filled />
                        <span className="sr-only">Pinned</span>
                      </>
                    )}
                    {post.title}
                  </h3>
                  <p>
                    <code className="admin-code">/blog/{post.slug}</code>
                    {post.tags.length > 0 && (
                      <span className="post-row-tags">
                        {post.tags.map((t) => `#${t}`).join(' ')}
                      </span>
                    )}
                  </p>
                </div>

                <div className="admin-row-when">
                  {post.publishedAt ? formatInZone(post.publishedAt) : 'No date'}
                </div>

                <span className={`badge admin-row-status ${STATE_BADGE[state]}`}>{state}</span>

                <div className="admin-row-actions">
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={() => void startEdit(post)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
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
      </section>
    </div>
  );
}
