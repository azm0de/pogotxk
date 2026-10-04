import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { AdminPost, PostStatus } from '~/lib/db/posts';
import { api, SignedOutError } from '~/lib/client-api';
import { renderMarkdown } from '~/lib/markdown';
import { slugify } from '~/lib/slug';
import { DEFAULT_TZ, formatInZone, utcToZoned } from '~/lib/time';
import {
  LoadNotice,
  scrollBehavior,
  Toast,
  useBeforeUnload,
  useToast,
  type LoadState,
} from './admin-ui';
import './PostEditor.css';

interface Props {
  /** Admins also get "Delete permanently"; everyone else archives. */
  isAdmin?: boolean;
}

/** Plain names for `media.kind`, to tell apart two images with the same alt. */
const KIND_LABEL: Record<string, string> = {
  photo: 'POI photo',
  community_photo: 'Community photo',
  doc: 'Document',
  import: 'Imported',
};

/** ATX heading, as `src/lib/markdown.ts` reads one. */
const HEADING_RE = /^ {0,3}(#{1,6})\s+/;
const FENCE_RE = /^ {0,3}(```|~~~)/;

/**
 * The heading offset that lands the body's shallowest heading on <h3>.
 *
 * The published page puts the body under the post's <h1>, so the renderer
 * starts it at <h2>. In the editor the preview sits under the form's own <h2>
 * ("Edit post"), so starting at <h2> there made the author's headings siblings
 * of the form heading, and a `#`/`###` body skipped a level (D-20). One level
 * deeper, consistently, keeps the page's outline h1 > h2 > h3.
 */
function previewHeadingOffset(source: string): number {
  let shallowest = 7;
  let inFence = false;
  for (const line of source.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (m) shallowest = Math.min(shallowest, (m[1] ?? '#').length);
  }
  return shallowest === 7 ? 2 : 3 - shallowest;
}

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

export default function PostEditor({ isAdmin = false }: Props) {
  const [posts, setPosts] = useState<AdminPost[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The list API may cap how many posts it returns; say so when it did. */
  const [truncated, setTruncated] = useState(false);
  const [media, setMedia] = useState<MediaOption[]>([]);
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  /** The form as it was opened (or last saved), to tell whether it is dirty. */
  const [baseline, setBaseline] = useState<Form | null>(null);
  /** Bumped to move focus into the form once it has rendered (C-15). */
  const [openTick, setOpenTick] = useState(0);
  const [slugTouched, setSlugTouched] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [pane, setPane] = useState<PaneMode>('split');
  const [busy, setBusy] = useState(false);
  /** True while a post's body is being fetched for the editor. */
  const [bodyLoading, setBodyLoading] = useState(false);
  /** True while a new hero image is uploading. */
  const [uploadingHero, setUploadingHero] = useState(false);
  /** Alt text queued for the *next* hero upload. An existing image's alt is edited in Media. */
  const [heroAlt, setHeroAlt] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { message, notify, fail, clear } = useToast();

  const dirty =
    editingId !== null && baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline);
  useBeforeUnload(dirty);

  /** Asks before unsaved work is thrown away. `true` means go ahead. */
  const confirmDiscard = () =>
    !dirty ||
    window.confirm(`Discard unsaved changes to "${form.title.trim() || 'this post'}"?`);

  const loadedRef = useRef(false);
  const reload = useCallback(async () => {
    // The list is what the page is for; the media options only feed the hero
    // picker. Loaded separately so a media hiccup cannot blank the list.
    try {
      const p = await api<{ posts: AdminPost[]; truncated?: boolean; total?: number }>(
        '/api/admin/posts',
      );
      setPosts(p.posts);
      setTruncated(
        Boolean(p.truncated) || (typeof p.total === 'number' && p.total > p.posts.length),
      );
      loadedRef.current = true;
      setLoad('ready');
      setLoadError(null);
    } catch (err) {
      if (loadedRef.current) fail(err, 'Could not reload the posts');
      else {
        setLoad(err instanceof SignedOutError ? 'signedout' : 'failed');
        setLoadError(err instanceof Error ? err.message : null);
      }
      return;
    }
    try {
      const m = await api<{ media: MediaOption[] }>('/api/admin/media?limit=200');
      setMedia(m.media);
    } catch (err) {
      fail(err, 'Could not load the image list');
    }
  }, [fail]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /*
   * Focus and scroll after the form has rendered. `scrollIntoView` used to be
   * called in the click handler, before the form existed on a first open, so
   * it did nothing — and focus stayed on the button, often far below the form
   * (admin audit, 2026-10, C-15).
   */
  useEffect(() => {
    if (openTick === 0) return;
    formRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    titleRef.current?.focus({ preventScroll: true });
  }, [openTick]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const startNew = () => {
    if (editingId === 'new' && !dirty) {
      setOpenTick((n) => n + 1);
      return;
    }
    if (!confirmDiscard()) return;
    setForm(EMPTY);
    setBaseline(EMPTY);
    setSlugTouched(false);
    setTagDraft('');
    setHeroAlt('');
    setEditingId('new');
    clear();
    setOpenTick((n) => n + 1);
  };

  const close = () => {
    if (!confirmDiscard()) return;
    setEditingId(null);
    setBaseline(null);
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
    if (editingId === post.id) {
      setOpenTick((n) => n + 1);
      return;
    }
    if (!confirmDiscard()) return;
    setEditingId(post.id);
    setSlugTouched(true); // An existing post has a URL; never rewrite it from the title.
    setTagDraft('');
    setHeroAlt('');
    clear();

    const opened: Form = {
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
    };
    setForm(opened);
    setBaseline(opened);
    setOpenTick((n) => n + 1);

    setBodyLoading(true);
    try {
      const { post: full } = await api<{ post: AdminPost }>(`/api/admin/posts/${post.id}`);
      // Guard against a slow response landing after the user opened another
      // post — otherwise this would drop one post's body into another's form.
      setEditingId((current) => {
        if (current === post.id) {
          setForm((f) => ({ ...f, bodyMd: full.bodyMd }));
          // The body arriving is not an edit.
          setBaseline((b) => (b ? { ...b, bodyMd: full.bodyMd } : b));
        }
        return current;
      });
    } catch (err) {
      fail(err, 'Could not load the post body');
      // Leave edit mode rather than offer an empty textarea that would wipe it
      // — but only if this is still the post on screen.
      setEditingId((current) => {
        if (current !== post.id) return current;
        setBaseline(null);
        return null;
      });
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
    clear();
    const sent = form;
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
      // What was sent is now what is stored; anything typed during the
      // request still counts as unsaved.
      setBaseline(sent);
      await reload();
      // Submit disabled the button mid-request, which drops focus to <body>.
      // Put it on the form's heading so the next Tab starts in the form.
      headingRef.current?.focus();
    } catch (err) {
      fail(err, 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Archive is the default (admin audit, 2026-10 — Justin's decision): the
   * row is kept with status `archived`, off the site, and can be brought back
   * by setting its status again. Permanent delete is a separate, admin-only
   * button.
   */
  const archive = async (post: AdminPost) => {
    const editingThis = editingId === post.id;
    if (
      !window.confirm(
        `Archive "${post.title}"? It comes off the site but is kept; set its status again to bring it back.` +
          (editingThis && dirty ? ' Your unsaved changes to it will be lost.' : ''),
      )
    )
      return;
    setBusy(true);
    clear();
    try {
      await api(`/api/admin/posts/${post.id}`, { method: 'DELETE' });
      if (editingThis) {
        setEditingId(null);
        setBaseline(null);
      }
      await reload();
      notify('ok', `Archived "${post.title}"`);
    } catch (err) {
      fail(err, 'Could not archive');
    } finally {
      setBusy(false);
    }
  };

  const destroy = async (post: AdminPost) => {
    if (!window.confirm(`Delete "${post.title}" permanently? This cannot be undone.`)) return;
    setBusy(true);
    clear();
    try {
      await api(`/api/admin/posts/${post.id}?hard=1`, { method: 'DELETE' });
      if (editingId === post.id) {
        setEditingId(null);
        setBaseline(null);
      }
      await reload();
      notify('ok', `Deleted "${post.title}" permanently`);
    } catch (err) {
      fail(err, 'Could not delete');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Uploads a new hero image and attaches it to the post being edited.
   *
   * A `FormData` body through the shared `api()`, which leaves the content
   * type for the browser to write. Mirrors `MapEditor.tsx`'s `uploadPhoto`, minus
   * `poiId`: the server already treats that as optional (`media.ts`), so a
   * standalone upload with no POI is a supported call.
   *
   * Deliberately does not call `reload()`. `reload()` only ever touches
   * `posts` and `media` state — it never reaches into `form` — so it would
   * not actually discard anything the author is mid-typing. It is skipped
   * anyway because it re-fetches the entire posts list for a change that
   * never touched a post, which is wasted work and, worse, means a hiccup in
   * that unrelated fetch would surface as "Could not load posts" right after
   * an upload that in fact succeeded. Appending the one new row locally is
   * the smaller, more precise update, and it is also faster: the option
   * appears the instant the upload response comes back rather than after a
   * second round trip.
   *
   * The 201 response is `{ id, key, url, ... }` — it does not echo back the
   * alt text just sent, so the new `media` entry is built from what this
   * component already knows rather than from the response alone.
   */
  const uploadHero = useCallback(
    async (file: File) => {
      setUploadingHero(true);
      try {
        const alt = heroAlt.trim();
        const body = new FormData();
        body.set('file', file);
        // Slugified server-side; falls back to the filename when this is blank.
        body.set('name', form.title);
        if (alt) body.set('alt', alt);

        clear();
        const created = await api<{ id: number; key: string }>('/api/admin/media', {
          method: 'POST',
          body,
        });

        setMedia((prev) => [
          { id: created.id, r2_key: created.key, alt: alt || null, kind: 'photo' },
          ...prev,
        ]);
        setForm((f) => ({ ...f, heroMediaId: created.id }));
        setHeroAlt('');
        notify('ok', alt ? 'Hero image uploaded' : 'Hero image uploaded — no alt text set');
      } catch (err) {
        fail(err, 'Upload failed');
      } finally {
        setUploadingHero(false);
      }
    },
    [heroAlt, form.title, notify, fail, clear],
  );

  // Rendering 20 KB of Markdown on every keystroke would make typing stutter;
  // `useDeferredValue` lets React keep the textarea responsive and catch the
  // preview up when it has a moment.
  const deferredBody = useDeferredValue(form.bodyMd);
  const previewHtml = useMemo(
    () => renderMarkdown(deferredBody, { headingOffset: previewHeadingOffset(deferredBody) }),
    [deferredBody],
  );

  /**
   * Hero picker labels. Keyed by alt text, two photos described the same way
   * were indistinguishable (C-20); a collision gets the kind and the id.
   */
  const mediaLabels = useMemo(() => {
    const base = (m: MediaOption) => m.alt || m.r2_key.split('/').pop() || m.r2_key;
    const seen = new Map<string, number>();
    for (const m of media) seen.set(base(m), (seen.get(base(m)) ?? 0) + 1);
    return new Map(
      media.map((m) => {
        const label = base(m);
        return [
          m.id,
          (seen.get(label) ?? 0) > 1 ? `${label} — ${KIND_LABEL[m.kind] ?? m.kind} #${m.id}` : label,
        ];
      }),
    );
  }, [media]);
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

      <Toast message={message} onDismiss={clear} />

      {editingId !== null && (
        <form
          className="post-form panel admin-form"
          onSubmit={submit}
          ref={formRef}
          aria-labelledby="post-form-heading"
        >
          <div className="post-form-head">
            <h2 id="post-form-heading" ref={headingRef} tabIndex={-1}>
              {editingId === 'new' ? 'New post' : 'Edit post'}
            </h2>
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
            <span>
              Title <em>(required)</em>
            </span>
            <input
              ref={titleRef}
              value={form.title}
              onChange={(e) => onTitle(e.target.value)}
              placeholder="e.g. August Community Day recap"
              required
              aria-required="true"
              maxLength={200}
            />
          </label>

          <div className="form-grid">
            <label>
              <span>
                Slug, the URL <em>(optional — made from the title)</em>
              </span>
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
            <div className="hero-field">
              <label>
                <span>
                  Hero image <em>(optional)</em>
                </span>
                <select
                  value={form.heroMediaId ?? ''}
                  onChange={(e) =>
                    set('heroMediaId', e.target.value ? Number(e.target.value) : null)
                  }
                >
                  <option value="">— none —</option>
                  {media.map((m) => (
                    <option key={m.id} value={m.id}>
                      {mediaLabels.get(m.id)}
                    </option>
                  ))}
                </select>
              </label>

              {/*
                The only other file input in admin attaches to a POI
                (MapEditor.tsx) — illustrating a post meant detouring through
                the map. `poiId` is optional server-side, so this is a
                standalone upload the API already supported with no UI
                reaching it.
              */}
              <div className="hero-upload">
                <label>
                  <span>
                    Alt text for a new upload <em>— what the photo shows, for screen readers</em>
                  </span>
                  <textarea
                    rows={2}
                    value={heroAlt}
                    onChange={(e) => setHeroAlt(e.target.value)}
                    placeholder="e.g. Trainers gathered at the pavilion for Community Day"
                    maxLength={300}
                  />
                </label>
                {/* Visible rather than a silent gap: the upload still goes
                    through either way — Media can fill this in later too —
                    but shipping an unlabelled image should never be quiet. */}
                {!heroAlt.trim() && (
                  <p className="form-note">
                    Left blank, the upload will have no screen-reader description. You can still
                    upload — add it here, or later in Media.
                  </p>
                )}
                <label className="hero-upload-btn">
                  {uploadingHero ? 'Uploading…' : 'Upload new image'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
                    disabled={uploadingHero}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadHero(f);
                      // So choosing the same file again still fires `change`.
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </div>
          </div>

          <label>
            <span>
              Excerpt <em>(optional) — the card blurb and meta description</em>
            </span>
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
                <span>
                  Tags <em>(optional)</em>
                </span>
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
                // Named, so the author's headings inside it are heard as the
                // preview's and not as the page's own sections (D-20).
                role="region"
                aria-label="Preview"
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
                the real one; saving mid-upload could file the save before the
                just-attached hero image's id ever reaches the form. */}
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || bodyLoading || uploadingHero}
            >
              {busy ? 'Saving…' : editingId === 'new' ? 'Create post' : 'Save changes'}
            </button>
            <button
              type="button"
              className="btn btn--outline"
              onClick={close}
              disabled={busy}
            >
              Close
            </button>
            <span className="admin-save-state" aria-live="polite">
              {dirty ? 'Unsaved changes' : editingId === 'new' ? 'Not saved yet' : 'No unsaved changes'}
            </span>
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
        {STATUS_FILTERS.map((value) => {
          const label = value === 'all' ? 'All' : value[0]?.toUpperCase() + value.slice(1);
          return (
            <button
              key={value}
              type="button"
              className="chip"
              aria-pressed={filter === value}
              // Read as "Draft, 2", not "Draft2" (D-20).
              aria-label={`${label}, ${counts[value] ?? 0}`}
              onClick={() => setFilter(value)}
            >
              {label}
              <span className="filter-count">{counts[value] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {truncated && load === 'ready' && (
        <p className="form-note">
          Showing the newest {posts.length} posts. Older ones are not listed here.
        </p>
      )}

      {load !== 'ready' ? (
        <LoadNotice
          state={load}
          what="the posts"
          error={loadError}
          onRetry={() => {
            setLoad('loading');
            void reload();
          }}
        />
      ) : visible.length === 0 ? (
        <p className="empty-state">
          {filter === 'all' ? 'Nothing here yet. Create a post above.' : `No ${filter} posts.`}
        </p>
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
                  {post.status !== 'archived' && (
                    <button
                      type="button"
                      className="btn btn--outline btn--sm"
                      onClick={() => void archive(post)}
                      disabled={busy}
                    >
                      Archive
                    </button>
                  )}
                  {isAdmin && (
                    <button
                      type="button"
                      className="btn btn--danger btn--sm"
                      onClick={() => void destroy(post)}
                      disabled={busy}
                    >
                      Delete permanently
                    </button>
                  )}
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
