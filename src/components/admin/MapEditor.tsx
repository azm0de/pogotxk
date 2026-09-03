import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { PoiType } from '~/lib/db/map';
import { basemapLayer } from '~/components/map/basemap';
import { poiIcon, TYPE_LABEL } from '~/components/map/markerIcons';
import '~/components/map/MapView.css';
import './MapEditor.css';

const TYPES: PoiType[] = ['pokestop', 'gym', 'powerspot'];
const STATUSES = ['published', 'pending', 'rejected', 'archived'] as const;
type Status = (typeof STATUSES)[number];

/** The badge variant each non-published status wears. The word is always
 *  printed beside it — colour is never the only signal here. */
const STATUS_BADGE: Record<Status, string> = {
  published: 'badge--live',
  pending: '',
  rejected: '',
  archived: 'badge--retired',
};

/**
 * The Ambassador star, drawn from the same path the map pin's Campsite badge
 * uses (`markerIcons.ts`) so the list and the pin are the same shape. A glyph
 * (★) stood here before; the world draws its icons.
 */
function StarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"
      />
    </svg>
  );
}

interface AdminPoi {
  id: number;
  slug: string;
  name: string;
  type: PoiType;
  description: string | null;
  lat: number;
  lng: number;
  is_campsite: number;
  is_meetup_spot: number;
  is_ex_eligible: number;
  sponsor: string | null;
  status: Status;
  hero_media_id: number | null;
  hero_key: string | null;
  sort: number;
}

type Draft = Pick<
  AdminPoi,
  'name' | 'type' | 'description' | 'lat' | 'lng' | 'status' | 'sponsor'
> & {
  isCampsite: boolean;
  isMeetupSpot: boolean;
  isExEligible: boolean;
};

function toDraft(p: AdminPoi): Draft {
  return {
    name: p.name,
    type: p.type,
    description: p.description,
    lat: p.lat,
    lng: p.lng,
    status: p.status,
    sponsor: p.sponsor,
    isCampsite: p.is_campsite === 1,
    isMeetupSpot: p.is_meetup_spot === 1,
    isExEligible: p.is_ex_eligible === 1,
  };
}

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

export default function MapEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef(new Map<number, L.Marker>());
  /** Read inside Leaflet handlers, which capture their closure once. */
  const addModeRef = useRef(false);

  const [pois, setPois] = useState<AdminPoi[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<PoiType | 'all'>('all');
  const [addMode, setAddMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  const selected = useMemo(() => pois.find((p) => p.id === selectedId) ?? null, [pois, selectedId]);
  const dirty = useMemo(() => {
    if (!selected || !draft) return false;
    return JSON.stringify(toDraft(selected)) !== JSON.stringify(draft);
  }, [selected, draft]);

  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    setMessage({ kind, text });
    window.setTimeout(() => setMessage(null), kind === 'ok' ? 2600 : 7000);
  }, []);

  const reload = useCallback(async () => {
    try {
      const data = await api<{ pois: AdminPoi[] }>('/api/admin/pois');
      setPois(data.pois);
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not load POIs');
    }
  }, [notify]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    addModeRef.current = addMode;
    const el = containerRef.current;
    if (el) el.style.cursor = addMode ? 'crosshair' : '';
  }, [addMode]);

  useEffect(() => {
    setDraft(selected ? toDraft(selected) : null);
  }, [selected]);

  // --- create ---------------------------------------------------------------
  const createAt = useCallback(
    async (lat: number, lng: number) => {
      setBusy(true);
      try {
        const created = await api<{ id: number; slug: string }>('/api/admin/pois', {
          method: 'POST',
          body: JSON.stringify({
            name: 'New location',
            type: 'pokestop',
            lat: Number(lat.toFixed(7)),
            lng: Number(lng.toFixed(7)),
            status: 'pending',
          }),
        });
        await reload();
        setSelectedId(created.id);
        setAddMode(false);
        notify('ok', 'Created — set the name and type, then save.');
      } catch (err) {
        notify('err', err instanceof Error ? err.message : 'Could not create');
      } finally {
        setBusy(false);
      }
    },
    [notify, reload],
  );

  // --- map init -------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [33.4640222, -94.0569268],
      zoom: 16,
      // The vector basemap over-zooms past its z15 data to here; kept in step
      // with the public map so both crop the park the same way.
      maxZoom: 20,
      zoomControl: true,
    });
    mapRef.current = map;

    // The same self-hosted Protomaps layer the public map uses — see basemap.ts.
    basemapLayer().addTo(map);

    layerRef.current = L.layerGroup().addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      if (addModeRef.current) void createAt(e.latlng.lat, e.latlng.lng);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      markersRef.current.clear();
    };
  }, [createAt]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pois.filter((p) => {
      if (typeFilter !== 'all' && p.type !== typeFilter) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.slug.includes(q)) return false;
      return true;
    });
  }, [pois, query, typeFilter]);

  /**
   * The current lists, readable from inside a Leaflet handler.
   *
   * Declared before every effect that reads them, because effects run in
   * declaration order and this one has to have written the refs first.
   */
  const visibleRef = useRef<AdminPoi[]>([]);
  const poisRef = useRef<AdminPoi[]>([]);
  useEffect(() => {
    visibleRef.current = visible;
    poisRef.current = pois;
  });

  /**
   * Everything the marker layer is built from *except* position.
   *
   * The rebuild effect used to be keyed on `visible`, so dragging one pin —
   * which writes the new position back into state — tore down and rebuilt all
   * 104 markers. Position is now synced onto the existing marker instead, and
   * the layer is only rebuilt when a pin's identity, icon or opacity changes.
   */
  const markerKey = useMemo(
    () =>
      visible
        .map((p) => `${p.id}:${p.type}:${p.is_campsite}:${p.is_meetup_spot}:${p.status}:${p.name}`)
        .join('|'),
    [visible],
  );

  // --- render markers -------------------------------------------------------
  useEffect(() => {
    const layer = layerRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;

    layer.clearLayers();
    markersRef.current.clear();

    for (const poi of visibleRef.current) {
      const marker = L.marker([poi.lat, poi.lng], {
        icon: poiIcon({
          type: poi.type,
          isCampsite: poi.is_campsite === 1,
          isMeetupSpot: poi.is_meetup_spot === 1,
        }),
        draggable: true,
        opacity: poi.status === 'published' ? 1 : 0.55,
        alt: `${poi.name} — ${TYPE_LABEL[poi.type]}`,
      });

      marker.on('click', () => setSelectedId(poi.id));

      // Where the pin was when this drag started. Read at dragstart rather than
      // closed over from the render, because the marker now outlives the render
      // that created it and its position is updated in place.
      let origin = marker.getLatLng();
      marker.on('dragstart', () => {
        origin = marker.getLatLng();
      });

      // Persist immediately on drop. Anything else means a moved pin can be
      // lost by navigating away, which is exactly the failure the old
      // hand-edited markers.js had.
      marker.on('dragend', async () => {
        const { lat, lng } = marker.getLatLng();
        const name = poisRef.current.find((p) => p.id === poi.id)?.name ?? poi.name;
        try {
          await api(`/api/admin/pois/${poi.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) }),
          });
          setPois((prev) => prev.map((p) => (p.id === poi.id ? { ...p, lat, lng } : p)));
          notify('ok', `Moved ${name}`);
        } catch (err) {
          marker.setLatLng(origin); // snap back on failure
          notify('err', err instanceof Error ? err.message : 'Could not move');
        }
      });

      marker.addTo(layer);
      markersRef.current.set(poi.id, marker);
    }
  }, [markerKey, notify]);

  // A position change moves the one marker it belongs to — from a drag, or from
  // the latitude and longitude fields in the form.
  useEffect(() => {
    for (const poi of visible) {
      const marker = markersRef.current.get(poi.id);
      if (!marker) continue;
      const at = marker.getLatLng();
      if (Math.abs(at.lat - poi.lat) > 1e-9 || Math.abs(at.lng - poi.lng) > 1e-9) {
        marker.setLatLng([poi.lat, poi.lng]);
      }
    }
  }, [visible]);

  // Highlight the selection without rebuilding every marker.
  useEffect(() => {
    for (const [id, marker] of markersRef.current) {
      const el = marker.getElement();
      if (el) el.classList.toggle('is-selected', id === selectedId);
    }
  }, [selectedId, markerKey]);

  // Pan on selection only. Panning on every position change would chase the map
  // across the park as someone types into the latitude field.
  useEffect(() => {
    if (selectedId === null) return;
    const poi = poisRef.current.find((p) => p.id === selectedId);
    if (poi) mapRef.current?.panTo([poi.lat, poi.lng]);
  }, [selectedId]);

  // --- save / delete --------------------------------------------------------
  const save = useCallback(async () => {
    if (!selected || !draft) return;
    // The coordinate fields are typed into, so they can be empty or half-typed.
    // Name the problem and the fix rather than sending NaN to the API.
    if (!Number.isFinite(draft.lat) || !Number.isFinite(draft.lng)) {
      notify('err', 'Latitude and longitude must both be numbers. Fill them in, or revert.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/admin/pois/${selected.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: draft.name,
          type: draft.type,
          description: draft.description || null,
          lat: Number(draft.lat.toFixed(7)),
          lng: Number(draft.lng.toFixed(7)),
          status: draft.status,
          sponsor: draft.sponsor || null,
          isCampsite: draft.isCampsite,
          isMeetupSpot: draft.isMeetupSpot,
          isExEligible: draft.isExEligible,
        }),
      });
      await reload();
      notify('ok', 'Saved');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }, [selected, draft, reload, notify]);

  const archive = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(`Archive "${selected.name}"? It disappears from the public map but stays recoverable.`)) return;
    setBusy(true);
    try {
      await api(`/api/admin/pois/${selected.id}`, { method: 'DELETE' });
      await reload();
      setSelectedId(null);
      notify('ok', 'Archived');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not archive');
    } finally {
      setBusy(false);
    }
  }, [selected, reload, notify]);

  const uploadPhoto = useCallback(
    async (file: File) => {
      if (!selected) return;
      setUploading(true);
      try {
        const body = new FormData();
        body.set('file', file);
        body.set('poiId', String(selected.id));
        body.set('name', selected.slug);
        body.set('alt', `${selected.name} — ${TYPE_LABEL[selected.type]}`);

        const res = await fetch('/api/admin/media', { method: 'POST', body });
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error ?? res.statusText);
        }
        await reload();
        notify('ok', 'Photo uploaded');
      } catch (err) {
        notify('err', err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [selected, reload, notify],
  );

  const counts = useMemo(() => {
    const c = { pokestop: 0, gym: 0, powerspot: 0, drafts: 0 };
    for (const p of pois) {
      c[p.type]++;
      if (p.status !== 'published') c.drafts++;
    }
    return c;
  }, [pois]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  return (
    <div className="editor">
      <aside className="editor-list">
        <div className="editor-list-head">
          <h1 className="editor-title">Map editor</h1>
          <input
            type="search"
            placeholder="Search POIs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search POIs"
          />
          <div className="editor-filters" role="group" aria-label="Filter by type">
            <button
              type="button"
              className="chip"
              aria-pressed={typeFilter === 'all'}
              onClick={() => setTypeFilter('all')}
            >
              All {pois.length}
            </button>
            {TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className="chip"
                aria-pressed={typeFilter === t}
                onClick={() => setTypeFilter(t)}
              >
                <span className={`chip-dot chip-dot--${t}`} aria-hidden="true" />
                {counts[t]}
              </button>
            ))}
          </div>
          {counts.drafts > 0 && (
            <p className="editor-drafts">{counts.drafts} not published</p>
          )}
        </div>

        <ul className="editor-items">
          {visible.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`editor-item${p.id === selectedId ? ' is-active' : ''}`}
                onClick={() => setSelectedId(p.id)}
              >
                <span className={`chip-dot chip-dot--${p.type}`} aria-hidden="true" />
                <span className="editor-item-name">{p.name}</span>
                {p.is_campsite === 1 && (
                  <>
                    <StarIcon className="editor-star" />
                    <span className="sr-only">Campsite</span>
                  </>
                )}
                {p.status !== 'published' && (
                  <span className={`badge ${STATUS_BADGE[p.status]}`}>{p.status}</span>
                )}
              </button>
            </li>
          ))}
          {visible.length === 0 && <li className="editor-empty">No matches.</li>}
        </ul>
      </aside>

      <div className="editor-map-wrap">
        {/* Leaflet's container is a focusable scroll region with no name of its
            own; without this it is announced as an unlabelled group. */}
        <div ref={containerRef} className="editor-map" role="application" aria-label="POI map" />

        <div className="editor-toolbar">
          <button
            type="button"
            className="btn"
            aria-pressed={addMode}
            onClick={() => setAddMode((v) => !v)}
            disabled={busy}
          >
            {addMode ? 'Click the map to place…' : 'Add POI'}
          </button>
          {addMode && (
            <button type="button" className="btn" onClick={() => setAddMode(false)}>
              Cancel
            </button>
          )}
        </div>

        {message && (
          <p className={`editor-toast editor-toast--${message.kind}`} role="status">
            {message.text}
          </p>
        )}
      </div>

      <aside className="editor-form" aria-label="Edit location">
        {!draft || !selected ? (
          <div className="editor-hint">
            <h2>Nothing selected</h2>
            <p>
              Pick a location from the list or the map to edit it. Drag any pin to move it, or type
              its coordinates into the form.
            </p>
            <p>
              Press <strong>Add POI</strong>, then click the map to place a new one.
            </p>
          </div>
        ) : (
          <form
            className="admin-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <header className="form-head">
              <h2>{selected.name}</h2>
              <code className="admin-code">{selected.slug}</code>
            </header>

            <label>
              <span>Name</span>
              <input
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
                required
                maxLength={200}
              />
            </label>

            <label>
              <span>Type</span>
              <select value={draft.type} onChange={(e) => set('type', e.target.value as PoiType)}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Description</span>
              <textarea
                rows={3}
                value={draft.description ?? ''}
                onChange={(e) => set('description', e.target.value)}
                maxLength={2000}
              />
            </label>

            <label>
              <span>Status</span>
              <select
                value={draft.status}
                onChange={(e) => set('status', e.target.value as Status)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="form-flags">
              <legend>Flags</legend>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.isCampsite}
                  onChange={(e) => set('isCampsite', e.target.checked)}
                />
                <span>Campsite</span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.isMeetupSpot}
                  onChange={(e) => set('isMeetupSpot', e.target.checked)}
                />
                <span>Meetup spot</span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.isExEligible}
                  onChange={(e) => set('isExEligible', e.target.checked)}
                />
                <span>EX eligible</span>
              </label>
            </fieldset>

            {/*
              Repositioning without a pointer.

              These two fields, not the drag, are what makes moving a POI
              reachable from a keyboard (WCAG 2.1.1) — and they are also how a
              surveyed coordinate gets pasted in exactly. Dragging still works
              and still saves on drop; these save with the rest of the form.
            */}
            <div className="form-coords">
              <label>
                <span>Latitude</span>
                <input
                  type="number"
                  step="0.0000001"
                  min={-90}
                  max={90}
                  inputMode="decimal"
                  required
                  value={Number.isFinite(draft.lat) ? draft.lat : ''}
                  onChange={(e) => set('lat', e.target.valueAsNumber)}
                />
              </label>
              <label>
                <span>Longitude</span>
                <input
                  type="number"
                  step="0.0000001"
                  min={-180}
                  max={180}
                  inputMode="decimal"
                  required
                  value={Number.isFinite(draft.lng) ? draft.lng : ''}
                  onChange={(e) => set('lng', e.target.valueAsNumber)}
                />
              </label>
              <p className="form-coords-hint">
                Seven decimal places. Dragging the pin on the map fills these in and saves straight
                away.
              </p>
            </div>

            <div className="form-photo">
              <span className="form-photo-label">Photo</span>
              {selected.hero_key ? (
                <img src={`/media/${selected.hero_key}`} alt="" />
              ) : (
                <p className="form-photo-none">No photo yet</p>
              )}
              <label className="upload-btn">
                {uploading ? 'Uploading…' : selected.hero_key ? 'Replace photo' : 'Add photo'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
                  disabled={uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadPhoto(f);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn--primary btn--sm" disabled={!dirty || busy}>
                {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
              </button>
              <button
                type="button"
                className="btn btn--outline btn--sm"
                onClick={() => setDraft(toDraft(selected))}
                disabled={!dirty || busy}
              >
                Revert
              </button>
              <button
                type="button"
                className="btn btn--danger btn--sm"
                onClick={archive}
                disabled={busy}
              >
                Archive
              </button>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
