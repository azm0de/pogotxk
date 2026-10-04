import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, SignedOutError } from '~/lib/client-api';
import { DEFAULT_TZ, formatInZone, utcToZoned } from '~/lib/time';
import {
  LoadNotice,
  scrollBehavior,
  Toast,
  useBeforeUnload,
  useToast,
  type LoadState,
} from './admin-ui';
import './MeetupEditor.css';

interface Props {
  /** Admins also get "Delete permanently"; everyone else cancels. */
  isAdmin?: boolean;
}

interface Meetup {
  id: number;
  slug: string;
  title: string;
  description_md: string | null;
  starts_at: string;
  ends_at: string | null;
  tz: string;
  poi_id: number | null;
  poi_name: string | null;
  location_text: string | null;
  campfire_url: string | null;
  recurrence_rule: string | null;
  status: 'draft' | 'published' | 'cancelled';
  announce_requested: number;
  announced_at: string | null;
}

interface PoiOption {
  id: number;
  name: string;
  type: string;
  status: string;
  is_meetup_spot: number;
}

interface Form {
  title: string;
  descriptionMd: string;
  startsAtLocal: string;
  endsAtLocal: string;
  tz: string;
  poiId: number | null;
  locationText: string;
  campfireUrl: string;
  status: Meetup['status'];
  /** "Also announce to Discord" — see notify/announcements.ts. */
  announce: boolean;
  /** When it was sent, or null while still owed. Never edited here. */
  announcedAt: string | null;
}

/** One status vocabulary across the console; the word is always printed. */
const STATUS_BADGE: Record<Meetup['status'], string> = {
  draft: '',
  published: 'badge--live',
  cancelled: 'badge--retired',
};

const STATUS_FILTERS = ['all', 'draft', 'published', 'cancelled'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * The POI type words, written out here rather than imported from
 * `markerIcons.ts`: that module imports Leaflet, which cannot load on the
 * server, and this island is server-rendered.
 */
const POI_TYPE_LABEL: Record<string, string> = {
  pokestop: 'PokéStop',
  gym: 'Gym',
  powerspot: 'Power Spot',
};

const EMPTY: Form = {
  title: '',
  descriptionMd: '',
  startsAtLocal: '',
  endsAtLocal: '',
  tz: DEFAULT_TZ,
  poiId: null,
  locationText: '',
  campfireUrl: '',
  status: 'draft',
  announce: false,
  announcedAt: null,
};

/**
 * What a save says about the announcement. The same three states the post
 * editor shows, for the same reason: the send is handed to `waitUntil`, so a
 * save can report the intent and never the delivery.
 */
type AnnounceStatus = 'off' | 'queued' | 'disabled';

interface Saved {
  announced: AnnounceStatus;
}

function announceSuffix(status: AnnounceStatus): string {
  if (status === 'queued') return ' · announcing to Discord';
  if (status === 'disabled') return ' · no Discord webhook is configured';
  return '';
}

export default function MeetupEditor({ isAdmin = false }: Props) {
  const [meetups, setMeetups] = useState<Meetup[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [pois, setPois] = useState<PoiOption[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  /** The form as it was opened (or last saved), to tell whether it is dirty. */
  const [baseline, setBaseline] = useState<Form | null>(null);
  /** Bumped to move focus into the form once it has rendered (C-15). */
  const [openTick, setOpenTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const { message, notify, fail, clear } = useToast();

  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const dirty =
    editingId !== null && baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline);
  useBeforeUnload(dirty);

  /** Asks before unsaved work is thrown away. `true` means go ahead. */
  const confirmDiscard = () =>
    !dirty ||
    window.confirm(`Discard unsaved changes to "${form.title.trim() || 'this meetup'}"?`);

  const loadedRef = useRef(false);
  const reload = useCallback(async () => {
    try {
      const m = await api<{ meetups: Meetup[]; total?: number; truncated?: boolean }>(
        '/api/admin/meetups',
      );
      setMeetups(m.meetups);
      setTruncated(
        Boolean(m.truncated) || (typeof m.total === 'number' && m.total > m.meetups.length),
      );
      loadedRef.current = true;
      setLoad('ready');
      setLoadError(null);
    } catch (err) {
      if (loadedRef.current) fail(err, 'Could not reload the meetups');
      else {
        setLoad(err instanceof SignedOutError ? 'signedout' : 'failed');
        setLoadError(err instanceof Error ? err.message : null);
      }
      return;
    }
    // The location list only feeds the dropdown; a failure here must not
    // blank the meetups.
    try {
      const p = await api<{ pois: PoiOption[] }>('/api/admin/pois');
      // Meetup spots first — that is almost always what gets picked.
      setPois(
        [...p.pois].sort(
          (a, b) => b.is_meetup_spot - a.is_meetup_spot || a.name.localeCompare(b.name),
        ),
      );
    } catch (err) {
      fail(err, 'Could not load the location list');
    }
  }, [fail]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /*
   * Focus and scroll after the form has rendered. The form opens above the
   * lists, so on a long list Edit used to open it off-screen with focus left
   * on the button (admin audit, 2026-10, C-15).
   */
  useEffect(() => {
    if (openTick === 0) return;
    formRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    titleRef.current?.focus({ preventScroll: true });
  }, [openTick]);

  const open = (id: number | 'new', next: Form) => {
    setForm(next);
    setBaseline(next);
    setEditingId(id);
    clear();
    setOpenTick((n) => n + 1);
  };

  const startNew = () => {
    if (editingId === 'new' && !dirty) {
      setOpenTick((n) => n + 1);
      return;
    }
    if (!confirmDiscard()) return;
    // Default to the next Wednesday at 6 PM — the community's usual slot.
    const d = new Date();
    d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7 || 7));
    d.setHours(18, 0, 0, 0);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}T18:00`;

    open('new', { ...EMPTY, startsAtLocal: local, endsAtLocal: local.replace('T18:00', 'T19:00') });
  };

  const toForm = (m: Meetup): Form => ({
    title: m.title,
    descriptionMd: m.description_md ?? '',
    startsAtLocal: utcToZoned(m.starts_at, m.tz),
    endsAtLocal: m.ends_at ? utcToZoned(m.ends_at, m.tz) : '',
    tz: m.tz,
    poiId: m.poi_id,
    locationText: m.location_text ?? '',
    campfireUrl: m.campfire_url ?? '',
    status: m.status,
    announce: m.announce_requested === 1,
    announcedAt: m.announced_at,
  });

  const startEdit = (m: Meetup) => {
    if (editingId === m.id) {
      setOpenTick((n) => n + 1);
      return;
    }
    if (!confirmDiscard()) return;
    open(m.id, toForm(m));
  };

  const close = () => {
    if (!confirmDiscard()) return;
    setEditingId(null);
    setBaseline(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    clear();
    const sent = form;
    try {
      const payload = {
        title: form.title,
        descriptionMd: form.descriptionMd || null,
        startsAtLocal: form.startsAtLocal,
        endsAtLocal: form.endsAtLocal || null,
        tz: form.tz,
        poiId: form.poiId,
        locationText: form.locationText || null,
        campfireUrl: form.campfireUrl || null,
        status: form.status,
        announce: form.announce,
      };
      if (editingId === 'new') {
        const created = await api<Saved & { id: number }>('/api/admin/meetups', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        notify('ok', `Meetup created${announceSuffix(created.announced)}`);
        // Stay in the form, now editing what was just made — as the news
        // editor does — rather than closing it and dropping focus on <body>.
        setEditingId(created.id);
      } else {
        const saved = await api<Saved>(`/api/admin/meetups/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        notify('ok', `Meetup saved${announceSuffix(saved.announced)}`);
      }
      setBaseline(sent);
      await reload();
      headingRef.current?.focus();
    } catch (err) {
      fail(err, 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Cancel is the default (admin audit, 2026-10 — Justin's decision): the row
   * is kept with status `cancelled`, which the calendar feed carries as a
   * cancellation. Permanent delete is a separate, admin-only button.
   */
  const cancelMeetup = async (m: Meetup) => {
    const editingThis = editingId === m.id;
    if (
      !window.confirm(
        `Cancel "${m.title}"? It stays listed as cancelled, and the calendar feed tells subscribers.` +
          (editingThis && dirty ? ' Your unsaved changes to it will be lost.' : ''),
      )
    )
      return;
    setBusy(true);
    clear();
    try {
      await api(`/api/admin/meetups/${m.id}`, { method: 'DELETE' });
      if (editingThis) {
        setEditingId(null);
        setBaseline(null);
      }
      await reload();
      notify('ok', `Cancelled "${m.title}"`);
    } catch (err) {
      fail(err, 'Could not cancel the meetup');
    } finally {
      setBusy(false);
    }
  };

  const destroy = async (m: Meetup) => {
    if (!window.confirm(`Delete "${m.title}" permanently? This cannot be undone.`)) return;
    setBusy(true);
    clear();
    try {
      await api(`/api/admin/meetups/${m.id}?hard=1`, { method: 'DELETE' });
      if (editingId === m.id) {
        setEditingId(null);
        setBaseline(null);
      }
      await reload();
      notify('ok', `Deleted "${m.title}" permanently`);
    } catch (err) {
      fail(err, 'Could not delete');
    } finally {
      setBusy(false);
    }
  };

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: meetups.length };
    for (const m of meetups) out[m.status] = (out[m.status] ?? 0) + 1;
    return out;
  }, [meetups]);

  const now = new Date().toISOString();
  const filtered = useMemo(
    () => (filter === 'all' ? meetups : meetups.filter((m) => m.status === filter)),
    [meetups, filter],
  );
  const upcoming = useMemo(
    () => filtered.filter((m) => (m.ends_at ?? m.starts_at) >= now),
    [filtered, now],
  );
  const past = useMemo(
    () => filtered.filter((m) => (m.ends_at ?? m.starts_at) < now),
    [filtered, now],
  );

  /**
   * The location dropdown: published places only, with duplicates told apart.
   *
   * It listed every POI — archived ones included — and the park has several
   * places sharing a name ("Boy Scouts of America" twice, "Walk Through
   * History" three times) with nothing to tell them apart (C-20). A shared name
   * now carries its type, and a shared name *and* type its id.
   */
  const poiOptions = useMemo(() => {
    const live = pois.filter((p) => p.status === 'published');
    const byName = new Map<string, number>();
    const byNameType = new Map<string, number>();
    for (const p of live) {
      byName.set(p.name, (byName.get(p.name) ?? 0) + 1);
      byNameType.set(`${p.name}|${p.type}`, (byNameType.get(`${p.name}|${p.type}`) ?? 0) + 1);
    }
    return live.map((p) => {
      let label = p.name;
      if ((byName.get(p.name) ?? 0) > 1) label += ` — ${POI_TYPE_LABEL[p.type] ?? p.type}`;
      if ((byNameType.get(`${p.name}|${p.type}`) ?? 0) > 1) label += ` #${p.id}`;
      // A word, not a glyph: an <option> cannot carry a drawn icon, and "★"
      // told a screen reader "black star".
      if (p.is_meetup_spot) label += ' (meetup spot)';
      return { id: p.id, label };
    });
  }, [pois]);

  /** The saved location, when it is no longer one the dropdown offers. */
  const offList = useMemo(() => {
    if (form.poiId === null || pois.length === 0) return null;
    if (poiOptions.some((o) => o.id === form.poiId)) return null;
    const p = pois.find((x) => x.id === form.poiId);
    return p
      ? { id: p.id, label: `${p.name} (${p.status})`, status: p.status }
      : { id: form.poiId, label: `Location #${form.poiId} (removed)`, status: 'removed' };
  }, [form.poiId, pois, poiOptions]);

  // Live preview of what the stored instant will be, so an author can see
  // straight away that "6 PM" means 6 PM Central and not 6 PM UTC.
  const preview = form.startsAtLocal
    ? (() => {
        try {
          return formatInZone(
            new Date(`${form.startsAtLocal}:00Z`).toISOString(),
            'UTC',
          ).replace(' UTC', '');
        } catch {
          return '';
        }
      })()
    : '';

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /*
   * One row shape across the console: name, when, status, actions. The news
   * list used the same four columns with the first two swapped, so the two
   * lists never scanned the same way; `.admin-row` in Admin.astro is now the
   * single definition and this list reads in its order.
   */
  const row = (m: Meetup) => (
    <li key={m.id} className={`card admin-row meetup-row--${m.status}`}>
      <div className="admin-row-main">
        <h3>{m.title}</h3>
        <p>
          {m.poi_name ?? m.location_text ?? 'No location set'}
          {m.recurrence_rule && <span className="meetup-repeat">Repeats</span>}
        </p>
      </div>
      <div className="admin-row-when">
        <strong>{formatInZone(m.starts_at, m.tz)}</strong>
        {m.ends_at && <span>to {formatInZone(m.ends_at, m.tz).split(', ').pop()}</span>}
      </div>
      <span className={`badge admin-row-status ${STATUS_BADGE[m.status]}`}>{m.status}</span>
      <div className="admin-row-actions">
        <button type="button" className="btn btn--outline btn--sm" onClick={() => startEdit(m)}>
          Edit
        </button>
        {m.status !== 'cancelled' && (
          <button
            type="button"
            className="btn btn--outline btn--sm"
            onClick={() => void cancelMeetup(m)}
            disabled={busy}
          >
            Cancel meetup
          </button>
        )}
        {isAdmin && (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => void destroy(m)}
            disabled={busy}
          >
            Delete permanently
          </button>
        )}
      </div>
    </li>
  );

  const filterWord = filter === 'all' ? '' : `${filter} `;

  return (
    <div className="meetups admin-page">
      <header className="meetups-head">
        <div>
          <h1>Meetups</h1>
          <p>Published meetups appear on the home page and in the calendar feed.</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={startNew}>
          New meetup
        </button>
      </header>

      <Toast message={message} onDismiss={clear} />

      {editingId !== null && (
        <form
          className="meetup-form panel admin-form"
          onSubmit={submit}
          ref={formRef}
          aria-labelledby="meetup-form-heading"
        >
          <h2 id="meetup-form-heading" ref={headingRef} tabIndex={-1}>
            {editingId === 'new' ? 'New meetup' : 'Edit meetup'}
          </h2>

          <label>
            <span>
              Title <em>(required)</em>
            </span>
            <input
              ref={titleRef}
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="e.g. Azelf Raid Hour"
              required
              aria-required="true"
              maxLength={200}
            />
          </label>

          <div className="form-grid">
            <label>
              <span>
                Starts <em>(required)</em>
              </span>
              <input
                type="datetime-local"
                value={form.startsAtLocal}
                onChange={(e) => set('startsAtLocal', e.target.value)}
                required
                aria-required="true"
              />
            </label>
            <label>
              <span>
                Ends <em>(optional)</em>
              </span>
              <input
                type="datetime-local"
                value={form.endsAtLocal}
                onChange={(e) => set('endsAtLocal', e.target.value)}
              />
            </label>
          </div>

          {preview && (
            <p className="form-note">
              {/* "Central time", not the zone id `America/Chicago` — nobody in
                  Texarkana thinks in zone ids (C-19). */}
              Interpreted as <strong>{preview}</strong>{' '}
              {form.tz === DEFAULT_TZ ? (
                'Central time'
              ) : (
                <>
                  in <code className="admin-code">{form.tz}</code>
                </>
              )}
              . The site works out CST vs CDT automatically.
            </p>
          )}

          <div className="form-grid">
            <label>
              <span>
                Location, a map place <em>(optional)</em>
              </span>
              <select
                value={form.poiId ?? ''}
                onChange={(e) => set('poiId', e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— none —</option>
                {offList && <option value={offList.id}>{offList.label}</option>}
                {poiOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>
                Or free text <em>(optional)</em>
              </span>
              <input
                value={form.locationText}
                onChange={(e) => set('locationText', e.target.value)}
                placeholder="Bramlett Field parking lot"
                maxLength={200}
              />
            </label>
          </div>

          {offList && (
            <p className="form-note">
              This meetup's saved location is{' '}
              {offList.status === 'removed'
                ? 'no longer on the map'
                : `${offList.status}, so it is not on the public map`}
              . Pick a published place, or leave it as it is.
            </p>
          )}

          <label>
            <span>
              Details <em>(optional, Markdown)</em>
            </span>
            <textarea
              rows={4}
              value={form.descriptionMd}
              onChange={(e) => set('descriptionMd', e.target.value)}
              placeholder="We will start by Bramlett Field parking lot. Check in via Campfire for in-game rewards!"
              maxLength={5000}
            />
          </label>

          <div className="form-grid">
            <label>
              <span>
                Campfire link <em>(optional)</em>
              </span>
              <input
                type="url"
                value={form.campfireUrl}
                onChange={(e) => set('campfireUrl', e.target.value)}
                placeholder="https://campfire.onelink.me/…"
              />
            </label>
            <label>
              <span>Status</span>
              <select
                value={form.status}
                onChange={(e) => set('status', e.target.value as Meetup['status'])}
              >
                <option value="draft">Draft — not public</option>
                <option value="published">Published</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          </div>

          {/*
            Announcing is one-way: the embed cannot be recalled from a channel
            with real members in it. So once sent this is a statement, not a
            control. A cancelled meetup is deliberately never announced fresh —
            the feed carries the cancellation, an embed would advertise it.
          */}
          <div className="announce-field">
            {form.announcedAt ? (
              <p className="announce-done">
                Announced to Discord {formatInZone(form.announcedAt, form.tz)}
              </p>
            ) : (
              <>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.announce}
                    onChange={(e) => set('announce', e.target.checked)}
                  />
                  <span>Also announce to Discord</span>
                </label>
                <p className="announce-note">
                  {/*
                    Written out rather than interpolated from `status`: the
                    statuses do not share a grammar. "while this is draft" was
                    what interpolation produced, and "a cancelled" is what
                    adding the article would produce for the other one.
                  */}
                  {!form.announce
                    ? 'Meetups are not announced unless you ask.'
                    : form.status === 'published'
                      ? 'Sent once, when you save.'
                      : form.status === 'draft'
                        ? 'Nothing is sent while this is a draft.'
                        : 'Cancelled meetups are never announced.'}
                </p>
              </>
            )}
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Saving…' : editingId === 'new' ? 'Create meetup' : 'Save changes'}
            </button>
            {/* "Close", not "Cancel": the rows now have a "Cancel meetup". */}
            <button type="button" className="btn btn--outline" onClick={close} disabled={busy}>
              Close
            </button>
            <span className="admin-save-state" aria-live="polite">
              {dirty ? 'Unsaved changes' : editingId === 'new' ? 'Not saved yet' : 'No unsaved changes'}
            </span>
          </div>
        </form>
      )}

      <div className="meetups-filters" role="group" aria-label="Filter by status">
        {STATUS_FILTERS.map((value) => {
          const label = value === 'all' ? 'All' : value[0]?.toUpperCase() + value.slice(1);
          return (
            <button
              key={value}
              type="button"
              className="chip"
              aria-pressed={filter === value}
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
          Showing the newest {meetups.length} meetups. Older ones are not listed here.
        </p>
      )}

      {load !== 'ready' ? (
        <LoadNotice
          state={load}
          what="the meetups"
          error={loadError}
          onRetry={() => {
            setLoad('loading');
            void reload();
          }}
        />
      ) : (
        <>
          <section>
            <h2>Upcoming ({upcoming.length})</h2>
            {upcoming.length ? (
              <ul className="admin-rows">{upcoming.map(row)}</ul>
            ) : (
              <p className="empty-state">
                {filter === 'all'
                  ? 'Nothing scheduled. Create one above.'
                  : `No upcoming ${filterWord}meetups.`}
              </p>
            )}
          </section>

          {past.length > 0 && (
            <section>
              <h2>Past ({past.length})</h2>
              <ul className="admin-rows meetup-list--past">{past.slice(0, 20).map(row)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
