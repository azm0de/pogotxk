import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_TZ, formatInZone, utcToZoned } from '~/lib/time';
import './MeetupEditor.css';

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
}

interface PoiOption {
  id: number;
  name: string;
  type: string;
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
}

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
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
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

export default function MeetupEditor() {
  const [meetups, setMeetups] = useState<Meetup[]>([]);
  const [pois, setPois] = useState<PoiOption[]>([]);
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    setMessage({ kind, text });
    window.setTimeout(() => setMessage(null), kind === 'ok' ? 2600 : 7000);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [m, p] = await Promise.all([
        api<{ meetups: Meetup[] }>('/api/admin/meetups'),
        api<{ pois: PoiOption[] }>('/api/admin/pois'),
      ]);
      setMeetups(m.meetups);
      // Meetup spots first — that is almost always what gets picked.
      setPois(
        [...p.pois].sort(
          (a, b) => b.is_meetup_spot - a.is_meetup_spot || a.name.localeCompare(b.name),
        ),
      );
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not load');
    }
  }, [notify]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startNew = () => {
    // Default to the next Wednesday at 6 PM — the community's usual slot.
    const d = new Date();
    d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7 || 7));
    d.setHours(18, 0, 0, 0);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}T18:00`;

    setForm({ ...EMPTY, startsAtLocal: local, endsAtLocal: local.replace('T18:00', 'T19:00') });
    setEditingId('new');
  };

  const startEdit = (m: Meetup) => {
    setForm({
      title: m.title,
      descriptionMd: m.description_md ?? '',
      startsAtLocal: utcToZoned(m.starts_at, m.tz),
      endsAtLocal: m.ends_at ? utcToZoned(m.ends_at, m.tz) : '',
      tz: m.tz,
      poiId: m.poi_id,
      locationText: m.location_text ?? '',
      campfireUrl: m.campfire_url ?? '',
      status: m.status,
    });
    setEditingId(m.id);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
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
      };
      if (editingId === 'new') {
        await api('/api/admin/meetups', { method: 'POST', body: JSON.stringify(payload) });
        notify('ok', 'Meetup created');
      } else {
        await api(`/api/admin/meetups/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        notify('ok', 'Meetup saved');
      }
      await reload();
      setEditingId(null);
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: Meetup) => {
    if (!window.confirm(`Delete "${m.title}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api(`/api/admin/meetups/${m.id}`, { method: 'DELETE' });
      await reload();
      if (editingId === m.id) setEditingId(null);
      notify('ok', 'Deleted');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not delete');
    } finally {
      setBusy(false);
    }
  };

  const now = new Date().toISOString();
  const upcoming = useMemo(
    () => meetups.filter((m) => (m.ends_at ?? m.starts_at) >= now),
    [meetups, now],
  );
  const past = useMemo(
    () => meetups.filter((m) => (m.ends_at ?? m.starts_at) < now),
    [meetups, now],
  );

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

  const row = (m: Meetup) => (
    <li key={m.id} className={`meetup-row meetup-row--${m.status}`}>
      <div className="meetup-when">
        <strong>{formatInZone(m.starts_at, m.tz)}</strong>
        {m.ends_at && <span>→ {formatInZone(m.ends_at, m.tz).split(', ').pop()}</span>}
      </div>
      <div className="meetup-main">
        <h3>{m.title}</h3>
        <p>
          {m.poi_name ?? m.location_text ?? 'No location set'}
          {m.recurrence_rule && <span className="meetup-repeat"> · repeats</span>}
        </p>
      </div>
      <span className={`meetup-status meetup-status--${m.status}`}>{m.status}</span>
      <div className="meetup-actions">
        <button type="button" onClick={() => startEdit(m)}>
          Edit
        </button>
        <button type="button" className="danger" onClick={() => void remove(m)} disabled={busy}>
          Delete
        </button>
      </div>
    </li>
  );

  return (
    <div className="meetups">
      <header className="meetups-head">
        <div>
          <h1>Meetups</h1>
          <p>
            This replaces editing <code>meetup.js</code> every week. Published meetups appear on
            the home page and in the calendar feed.
          </p>
        </div>
        <button type="button" className="btn" onClick={startNew}>
          + New meetup
        </button>
      </header>

      {message && (
        <p className={`meetups-toast meetups-toast--${message.kind}`} role="status">
          {message.text}
        </p>
      )}

      {editingId !== null && (
        <form className="meetup-form" onSubmit={submit}>
          <h2>{editingId === 'new' ? 'New meetup' : 'Edit meetup'}</h2>

          <label>
            <span>Title</span>
            <input
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="e.g. Azelf Raid Hour"
              required
              maxLength={200}
            />
          </label>

          <div className="form-grid">
            <label>
              <span>Starts</span>
              <input
                type="datetime-local"
                value={form.startsAtLocal}
                onChange={(e) => set('startsAtLocal', e.target.value)}
                required
              />
            </label>
            <label>
              <span>Ends (optional)</span>
              <input
                type="datetime-local"
                value={form.endsAtLocal}
                onChange={(e) => set('endsAtLocal', e.target.value)}
              />
            </label>
          </div>

          {preview && (
            <p className="form-note">
              Interpreted as <strong>{preview}</strong> in <code>{form.tz}</code>. The site works
              out CST vs CDT automatically.
            </p>
          )}

          <div className="form-grid">
            <label>
              <span>Location (a map POI)</span>
              <select
                value={form.poiId ?? ''}
                onChange={(e) => set('poiId', e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— none —</option>
                {pois.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.is_meetup_spot ? '★ ' : ''}
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Or free text</span>
              <input
                value={form.locationText}
                onChange={(e) => set('locationText', e.target.value)}
                placeholder="Bramlett Field parking lot"
                maxLength={200}
              />
            </label>
          </div>

          <label>
            <span>Details (Markdown)</span>
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
              <span>Campfire link (optional)</span>
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

          <div className="form-actions">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Saving…' : editingId === 'new' ? 'Create meetup' : 'Save changes'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setEditingId(null)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <section>
        <h2>Upcoming ({upcoming.length})</h2>
        {upcoming.length ? (
          <ul className="meetup-list">{upcoming.map(row)}</ul>
        ) : (
          <p className="meetups-empty">Nothing scheduled. Create one above.</p>
        )}
      </section>

      {past.length > 0 && (
        <section>
          <h2>Past ({past.length})</h2>
          <ul className="meetup-list meetup-list--past">{past.slice(0, 20).map(row)}</ul>
        </section>
      )}
    </div>
  );
}
