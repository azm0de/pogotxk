import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, SignedOutError } from '~/lib/client-api';
import { LoadNotice, Toast, useBeforeUnload, useToast, type LoadState } from './admin-ui';
import './MediaLibrary.css';

/**
 * The media library.
 *
 * Its job is attribution. Every photo on the site arrived through the legacy
 * import carrying a photographer byline, an article title, a date and a link,
 * and those are a licensing obligation rather than decoration — but until this
 * page existed, correcting one meant hand-writing SQL against production.
 *
 * Uploading already worked from the map editor, so this is deliberately not a
 * second uploader: it is a browser and an editor for what is already stored.
 *
 * The credit renders *on* the photograph here, through the same `.figure` /
 * `.credit` primitives the public site uses, because that is where the credit
 * has to live — and because a library whose job is attribution should show at a
 * glance which pictures carry theirs.
 */

interface MediaItem {
  id: number;
  r2_key: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  alt: string | null;
  caption: string | null;
  credit: string | null;
  source_title: string | null;
  source_date: string | null;
  source_url: string | null;
  kind: string;
  created_at: string;
}

interface Draft {
  alt: string;
  caption: string;
  credit: string;
  sourceTitle: string;
  sourceDate: string;
  sourceUrl: string;
  kind: string;
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'community_photo', label: 'Community photos' },
  { id: 'photo', label: 'POI photos' },
  { id: 'needs-credit', label: 'Missing credit' },
  { id: 'needs-alt', label: 'Missing alt text' },
] as const;

/**
 * Which kinds owe a credit to someone else.
 *
 * `community_photo` is the press photography — Texarkana Gazette bylines and
 * the like — where naming the photographer is a licensing obligation. `import`
 * is whatever has not been classified yet, so it stays in until someone says
 * otherwise.
 *
 * `photo` and `doc` are ours: the POI photographs were shot by members for this
 * site, and a `doc` is our own paperwork. There is no third party to name, so
 * an empty `credit` on one of those is not a gap.
 *
 * This distinction is the whole point. Counting every empty `credit` made the
 * filter report 63 outstanding tasks — every POI photograph in the library —
 * when the real number was zero, which is how a gap counter stops being read.
 */
const CREDIT_OWED: ReadonlySet<string> = new Set(['community_photo', 'import']);

/** A credit that is genuinely missing, rather than simply not applicable. */
function creditMissing(item: MediaItem): boolean {
  return CREDIT_OWED.has(item.kind) && !item.credit;
}

type FilterId = (typeof FILTERS)[number]['id'];

/** Everything inside the sheet that can take focus, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A drawn close mark — the world does not use glyphs as icons. */
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M6 6l12 12M18 6L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Every `media.kind` the API accepts, in plain words. The sheet offered only
 * the first two, so opening a `doc` or `import` row showed the wrong kind and
 * saving it silently reclassified the file (admin audit, 2026-10, B-04).
 */
const KINDS: { id: string; label: string }[] = [
  { id: 'photo', label: 'POI photo' },
  { id: 'community_photo', label: 'Community photo (shows in the gallery)' },
  { id: 'doc', label: 'Document' },
  { id: 'import', label: 'Imported (unclassified)' },
];

/** The file's own name, which is what a person recognises it by. */
const fileName = (item: MediaItem) => item.r2_key.split('/').pop() ?? item.r2_key;

function toDraft(item: MediaItem): Draft {
  return {
    alt: item.alt ?? '',
    caption: item.caption ?? '',
    credit: item.credit ?? '',
    sourceTitle: item.source_title ?? '',
    sourceDate: item.source_date ?? '',
    sourceUrl: item.source_url ?? '',
    kind: item.kind,
  };
}

function formatBytes(n: number | null): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export default function MediaLibrary() {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  /** The list API may cap how many rows it returns; say so when it did. */
  const [total, setTotal] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterId>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const { message, notify, fail, clear } = useToast();

  const sheetRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  /** The tile the sheet was opened from, so focus can go back to it. */
  const openerRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async (): Promise<MediaItem[]> => {
    try {
      const data = await api<{ media: MediaItem[]; total?: number }>('/api/admin/media?limit=500');
      setItems(data.media);
      setTotal(typeof data.total === 'number' ? data.total : null);
      setLoadState('ready');
      setError(null);
      return data.media;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A failed reload behind an open sheet keeps the grid it already has.
      setLoadState((s) => (s === 'ready' ? s : err instanceof SignedOutError ? 'signedout' : 'failed'));
      throw err;
    }
  }, []);

  useEffect(() => {
    // The failure is already in state for <LoadNotice>; nothing else to do.
    load().catch(() => undefined);
  }, [load]);

  const visible = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === 'community_photo' && item.kind !== 'community_photo') return false;
      if (filter === 'photo' && item.kind !== 'photo') return false;
      if (filter === 'needs-credit' && !creditMissing(item)) return false;
      if (filter === 'needs-alt' && item.alt) return false;
      if (!q) return true;
      return [item.r2_key, item.alt, item.caption, item.credit, item.source_title]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q));
    });
  }, [items, filter, query]);

  // Surfaced rather than buried in a filter: these are the licensing gaps, and
  // a count that stares back is what gets them closed.
  const gaps = useMemo(() => {
    if (!items) return { credit: 0, alt: 0 };
    return {
      credit: items.filter(creditMissing).length,
      alt: items.filter((i) => !i.alt).length,
    };
  }, [items]);

  const open = useCallback(
    (item: MediaItem, trigger: HTMLButtonElement) => {
      openerRef.current = trigger;
      setOpenId(item.id);
      setDraft(toDraft(item));
      clear();
    },
    [clear],
  );

  const openItem = items?.find((i) => i.id === openId) ?? null;
  const dirty =
    openItem !== null && draft !== null && JSON.stringify(toDraft(openItem)) !== JSON.stringify(draft);
  useBeforeUnload(dirty);

  /** Read by the document-level key handler, which is bound once per open. */
  const dirtyRef = useRef(false);
  const openNameRef = useRef('');
  useEffect(() => {
    dirtyRef.current = dirty;
    openNameRef.current = openItem ? fileName(openItem) : '';
  });

  const close = useCallback(() => {
    setOpenId(null);
    setDraft(null);
    const opener = openerRef.current;
    openerRef.current = null;
    // After a save the list is reloaded, so the tile that opened the sheet may
    // no longer be the same element. Fall back to the first tile rather than
    // dropping focus on <body>, which would send the next Tab back to the top
    // of the page.
    window.requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
      else gridRef.current?.querySelector<HTMLButtonElement>('.media-tile')?.focus();
    });
  }, []);

  /**
   * Every way out of the sheet — Escape, the backdrop, the close button — asks
   * first if there are edits. Escape and a stray backdrop click used to throw
   * typed attribution away without a word (admin audit, 2026-10, C-22).
   */
  const requestClose = useCallback(() => {
    if (
      dirtyRef.current &&
      !window.confirm(`Discard unsaved changes to "${openNameRef.current || 'this file'}"?`)
    )
      return;
    close();
  }, [close]);

  // The page behind a modal sheet must not scroll under it (C-22 / D-19).
  useEffect(() => {
    if (openId === null) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = before;
    };
  }, [openId]);

  /**
   * Dialog focus management.
   *
   * `role="dialog" aria-modal="true"` was already here and did nothing on its
   * own: focus stayed behind the sheet, Tab walked out into the page under it,
   * and Escape did nothing (WCAG 2.4.3, the ARIA dialog pattern). Focus goes to
   * the sheet on open so its name is announced, Tab wraps inside it, Escape
   * closes it, and `close()` puts focus back on the tile.
   */
  useEffect(() => {
    if (openId === null) return;
    const sheet = sheetRef.current;
    sheet?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key !== 'Tab' || !sheet) return;
      const stops = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) {
        e.preventDefault();
        sheet.focus();
        return;
      }
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === sheet)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [openId, requestClose]);

  const save = useCallback(async () => {
    if (openId === null || !draft || !openItem) return;
    // Only the fields that changed. The API validates what it is sent, so an
    // untouched legacy value (an old source URL, say) can no longer block a
    // fix to the alt text beside it.
    const before = toDraft(openItem);
    const changed = Object.fromEntries(
      (Object.keys(draft) as (keyof Draft)[])
        .filter((k) => draft[k] !== before[k])
        .map((k) => [k, draft[k]]),
    );
    if (Object.keys(changed).length === 0) return;
    setSaving(true);
    clear();
    try {
      await api(`/api/admin/media/${openId}`, {
        method: 'PATCH',
        body: JSON.stringify(changed),
      });
      // Reload rather than patching local state: the server decides what an
      // empty string became, and guessing here is how the two drift apart.
      const fresh = await load();
      const saved = fresh.find((i) => i.id === openId);
      if (saved) setDraft(toDraft(saved));
      notify('ok', 'Saved');
    } catch (err) {
      fail(err, 'Could not save');
    } finally {
      setSaving(false);
    }
  }, [openId, draft, openItem, load, notify, fail, clear]);

  if (!items) {
    return (
      <div className="media admin-page admin-page--wide">
        <h1 className="sr-only">Media</h1>
        <LoadNotice
          state={loadState}
          what="the media library"
          error={error}
          onRetry={() => {
            setLoadState('loading');
            load().catch(() => undefined);
          }}
        />
      </div>
    );
  }

  return (
    <div className="media admin-page admin-page--wide">
      <header className="panel-head media-head">
        <h1>Media</h1>
        <p className="count">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </p>
      </header>

      <div className="media-bar">
        <div className="media-filters" role="group" aria-label="Filter media">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="chip"
              aria-pressed={filter === f.id}
              aria-label={
                f.id === 'needs-credit' && gaps.credit > 0
                  ? `${f.label}, ${gaps.credit}`
                  : f.id === 'needs-alt' && gaps.alt > 0
                    ? `${f.label}, ${gaps.alt}`
                    : undefined
              }
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {f.id === 'needs-credit' && gaps.credit > 0 && (
                <span className="disc media-count">{gaps.credit}</span>
              )}
              {f.id === 'needs-alt' && gaps.alt > 0 && (
                <span className="disc media-count">{gaps.alt}</span>
              )}
            </button>
          ))}
        </div>

        <label className="media-search">
          <span className="sr-only">Search media by name, credit or caption</span>
          <input
            type="search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      <p className="media-summary">
        {visible.length} of {items.length} items
        {gaps.credit > 0 && ` · ${gaps.credit} with no credit`}
        {gaps.alt > 0 && ` · ${gaps.alt} with no alt text`}
        {total !== null && total > items.length && ` · showing the newest ${items.length} of ${total}`}
      </p>

      <ul className="media-grid" ref={gridRef}>
        {visible.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="media-tile"
              onClick={(e) => open(item, e.currentTarget)}
            >
              {/* Spans rather than <figure>/<figcaption>: this is inside a
                  <button>, whose content model does not allow them. The classes
                  are the primitives'; the scrim and its measured contrast are
                  unchanged. */}
              <span className="figure media-figure">
                <img
                  src={`/media/${item.r2_key}`}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  width={item.width ?? 320}
                  height={item.height ?? 240}
                />
                {item.credit && <span className="credit">{item.credit}</span>}
              </span>
              <span className="media-tile-meta">
                <span className="media-tile-name">{item.r2_key.split('/').pop()}</span>
                <span className="media-tile-flags">
                  {creditMissing(item) && <span className="badge media-flag--gap">No credit</span>}
                  {!item.alt && <span className="badge">No alt</span>}
                  {item.kind === 'community_photo' && <span className="badge">Community</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {visible.length === 0 && <p className="empty-state">Nothing matches that filter.</p>}

      {openItem && draft && (
        <div className="media-sheet-backdrop" onClick={requestClose} role="presentation">
          <div
            className="media-sheet admin-form"
            ref={sheetRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            // "Attribution, <file>": the heading alone named every sheet the
            // same, so a screen reader could not tell which photo was open (D-19).
            aria-labelledby="media-sheet-title media-sheet-file"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="media-sheet-head">
              <div className="media-sheet-titles">
                <h2 id="media-sheet-title">Attribution</h2>
                <p id="media-sheet-file" className="media-sheet-file">
                  {fileName(openItem)}
                </p>
              </div>
              <button
                type="button"
                className="media-close"
                onClick={requestClose}
                aria-label="Close, without saving"
              >
                <CloseIcon />
              </button>
            </div>

            <figure className="figure media-figure media-figure--preview">
              <img src={`/media/${openItem.r2_key}`} alt="" />
              {openItem.credit && <figcaption className="credit">{openItem.credit}</figcaption>}
            </figure>

            <p className="media-facts">
              {openItem.mime} · {openItem.width ?? '?'}×{openItem.height ?? '?'} ·{' '}
              {formatBytes(openItem.bytes)}
              <br />
              <code className="admin-code">{openItem.r2_key}</code>
            </p>

            <label className="media-field">
              <span>
                Alt text <em>— what the photo shows, for screen readers</em>
              </span>
              <textarea
                rows={2}
                value={draft.alt}
                onChange={(e) => setDraft({ ...draft, alt: e.target.value })}
              />
            </label>

            <label className="media-field">
              <span>Caption</span>
              <textarea
                rows={2}
                value={draft.caption}
                onChange={(e) => setDraft({ ...draft, caption: e.target.value })}
              />
            </label>

            <label className="media-field">
              <span>
                Credit <em>— the photographer. Required for press photos.</em>
              </span>
              <input
                type="text"
                value={draft.credit}
                onChange={(e) => setDraft({ ...draft, credit: e.target.value })}
              />
            </label>

            <div className="media-row">
              <label className="media-field">
                <span>Source title</span>
                <input
                  type="text"
                  value={draft.sourceTitle}
                  onChange={(e) => setDraft({ ...draft, sourceTitle: e.target.value })}
                />
              </label>
              <label className="media-field">
                <span>Source date</span>
                <input
                  type="text"
                  value={draft.sourceDate}
                  onChange={(e) => setDraft({ ...draft, sourceDate: e.target.value })}
                />
              </label>
            </div>

            <label className="media-field">
              <span>Source URL</span>
              <input
                type="url"
                inputMode="url"
                value={draft.sourceUrl}
                onChange={(e) => setDraft({ ...draft, sourceUrl: e.target.value })}
              />
            </label>

            <label className="media-field">
              <span>Kind</span>
              <select
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
                {/* A kind the API knows and this list does not: show it
                    rather than let the select silently pick the first option. */}
                {!KINDS.some((k) => k.id === draft.kind) && (
                  <option value={draft.kind}>{draft.kind}</option>
                )}
              </select>
            </label>

            <div className="media-sheet-foot">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={save}
                disabled={saving || !dirty}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <a
                className="btn btn--outline btn--sm btn--arrow"
                href={`/media/${openItem.r2_key}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the file
              </a>
              <span className="admin-save-state" aria-live="polite">
                {dirty ? 'Unsaved changes' : 'No unsaved changes'}
              </span>
            </div>
            <Toast message={message} onDismiss={clear} />
          </div>
        </div>
      )}
    </div>
  );
}
