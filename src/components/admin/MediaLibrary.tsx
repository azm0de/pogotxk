import { useCallback, useEffect, useMemo, useState } from 'react';
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

type FilterId = (typeof FILTERS)[number]['id'];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    // Astro rejects cross-site POSTs without a JSON content-type.
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

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
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api<{ media: MediaItem[] }>('/api/admin/media?limit=500');
      setItems(data.media);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === 'community_photo' && item.kind !== 'community_photo') return false;
      if (filter === 'photo' && item.kind !== 'photo') return false;
      if (filter === 'needs-credit' && item.credit) return false;
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
      credit: items.filter((i) => !i.credit).length,
      alt: items.filter((i) => !i.alt).length,
    };
  }, [items]);

  const open = useCallback((item: MediaItem) => {
    setOpenId(item.id);
    setDraft(toDraft(item));
    setStatus('');
  }, []);

  const close = useCallback(() => {
    setOpenId(null);
    setDraft(null);
  }, []);

  const save = useCallback(async () => {
    if (openId === null || !draft) return;
    setSaving(true);
    setStatus('');
    try {
      await api(`/api/admin/media/${openId}`, {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      // Reload rather than patching local state: the server decides what an
      // empty string became, and guessing here is how the two drift apart.
      await load();
      setStatus('Saved.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [openId, draft, load]);

  if (error) {
    return (
      <p className="media-error" role="alert">
        {error}
      </p>
    );
  }

  if (!items) return <p className="media-loading">Loading media…</p>;

  const openItem = items.find((i) => i.id === openId) ?? null;

  return (
    <div className="media">
      <div className="media-bar">
        <div className="media-filters" role="group" aria-label="Filter media">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="media-chip"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {f.id === 'needs-credit' && gaps.credit > 0 && (
                <span className="media-count">{gaps.credit}</span>
              )}
              {f.id === 'needs-alt' && gaps.alt > 0 && (
                <span className="media-count">{gaps.alt}</span>
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
      </p>

      <ul className="media-grid">
        {visible.map((item) => (
          <li key={item.id}>
            <button type="button" className="media-tile" onClick={() => open(item)}>
              <img
                src={`/media/${item.r2_key}`}
                alt=""
                loading="lazy"
                decoding="async"
                width={item.width ?? 320}
                height={item.height ?? 240}
              />
              <span className="media-tile-meta">
                <span className="media-tile-name">{item.r2_key.split('/').pop()}</span>
                <span className="media-tile-flags">
                  {!item.credit && <span className="media-flag media-flag--warn">no credit</span>}
                  {!item.alt && <span className="media-flag">no alt</span>}
                  {item.kind === 'community_photo' && <span className="media-flag">community</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {visible.length === 0 && (
        <p className="media-empty">Nothing matches that filter.</p>
      )}

      {openItem && draft && (
        <div className="media-sheet-backdrop" onClick={close} role="presentation">
          <div
            className="media-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`Edit ${openItem.r2_key}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="media-sheet-head">
              <h2>Attribution</h2>
              <button type="button" className="media-close" onClick={close} aria-label="Close">
                ✕
              </button>
            </div>

            <img className="media-preview" src={`/media/${openItem.r2_key}`} alt="" />

            <p className="media-facts">
              {openItem.mime} · {openItem.width ?? '?'}×{openItem.height ?? '?'} ·{' '}
              {formatBytes(openItem.bytes)}
              <br />
              <code>{openItem.r2_key}</code>
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
                <option value="photo">POI photo</option>
                <option value="community_photo">Community photo (shows in the gallery)</option>
              </select>
            </label>

            <div className="media-sheet-foot">
              <button type="button" className="media-save" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <a className="media-view" href={`/media/${openItem.r2_key}`} target="_blank" rel="noopener noreferrer">
                Open the file
              </a>
              <span className="media-status" role="status" aria-live="polite">
                {status}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
