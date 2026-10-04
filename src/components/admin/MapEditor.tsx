import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { PoiType } from '~/lib/db/map';
import { api, SignedOutError } from '~/lib/client-api';
import { basemapLayer } from '~/components/map/basemap';
import { poiIcon, TYPE_LABEL } from '~/components/map/markerIcons';
import { LoadNotice, Toast, useBeforeUnload, useToast, type LoadState } from './admin-ui';
import '~/components/map/MapView.css';
import './MapEditor.css';

const TYPES: PoiType[] = ['pokestop', 'gym', 'powerspot'];
const STATUSES = ['published', 'pending', 'rejected', 'archived'] as const;
type Status = (typeof STATUSES)[number];

/** The chip's visible word. The dot beside it is a 9px swatch whose hues sit
 *  1.18–1.53:1 apart, so it cannot carry the type on its own (D-02 / D-04). */
const TYPE_PLURAL: Record<PoiType, string> = {
  pokestop: 'PokéStops',
  gym: 'Gyms',
  powerspot: 'Power Spots',
};

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

/** A saved location's id, an unsaved new one, or nothing. */
type Selection = number | 'new' | null;

/** Seven decimal places (~1cm) — what the API stores and the inputs step by. */
const round7 = (n: number) => Number(n.toFixed(7));

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

/**
 * A location that exists only on screen until Save.
 *
 * Clicking the map in add mode used to POST a "New location" row straight
 * away, before anything was typed, so an abandoned click left a stray pending
 * pin in the database (admin audit, 2026-10, C-17). Now nothing is written
 * until the person saves.
 */
function newDraft(lat: number, lng: number): Draft {
  return {
    name: 'New location',
    type: 'pokestop',
    description: null,
    lat: round7(lat),
    lng: round7(lng),
    status: 'pending',
    sponsor: null,
    isCampsite: false,
    isMeetupSpot: false,
    isExEligible: false,
  };
}

const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/** "just now", "4 min ago", then the clock time. */
function savedAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function MapEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef(new Map<number, L.Marker>());
  /** The pin for an unsaved new location; kept out of `layerRef`, which is
   *  cleared whenever the saved pins are rebuilt. */
  const newMarkerRef = useRef<L.Marker | null>(null);
  const newMarkerTypeRef = useRef<PoiType | null>(null);
  /** Read inside Leaflet handlers, which capture their closure once. */
  const addModeRef = useRef(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  const hintHeadingRef = useRef<HTMLHeadingElement>(null);

  const [pois, setPois] = useState<AdminPoi[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Set when the list API capped its answer: how many exist in all. */
  const [listTotal, setListTotal] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<Selection>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<PoiType | 'all'>('all');
  const [addMode, setAddMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** Which location was last saved, and when — for "Saved · just now". */
  const [savedAt, setSavedAt] = useState<{ id: number; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Bumped to move focus into the Name field after the form opens. */
  const [focusName, setFocusName] = useState(0);
  const { message, notify, fail, clear } = useToast();

  const selected = useMemo(
    () => (typeof selectedId === 'number' ? (pois.find((p) => p.id === selectedId) ?? null) : null),
    [pois, selectedId],
  );
  const isNew = selectedId === 'new';
  const dirty = useMemo(() => {
    if (!draft) return false;
    if (isNew) return true; // an unsaved location is unsaved work by definition
    if (!selected) return false;
    return !sameDraft(toDraft(selected), draft);
  }, [selected, draft, isNew]);

  useBeforeUnload(dirty);

  /**
   * The current values, readable from inside a Leaflet handler and from the
   * confirm guard. Declared before every effect that reads them, because
   * effects run in declaration order and this one has to have written first.
   */
  const dirtyRef = useRef(false);
  const draftRef = useRef<Draft | null>(null);
  const selectedIdRef = useRef<Selection>(null);
  useEffect(() => {
    dirtyRef.current = dirty;
    draftRef.current = draft;
    selectedIdRef.current = selectedId;
  });

  const loadedRef = useRef(false);
  const reload = useCallback(async (): Promise<boolean> => {
    try {
      const data = await api<{ pois: AdminPoi[]; total?: number; truncated?: boolean }>(
        '/api/admin/pois',
      );
      setPois(data.pois);
      setListTotal(
        data.truncated || (typeof data.total === 'number' && data.total > data.pois.length)
          ? (data.total ?? null)
          : null,
      );
      loadedRef.current = true;
      setLoad('ready');
      setLoadError(null);
      return true;
    } catch (err) {
      if (loadedRef.current) {
        // The list is already on screen; say what failed and keep it.
        fail(err, 'Could not reload the locations');
      } else {
        setLoad(err instanceof SignedOutError ? 'signedout' : 'failed');
        setLoadError(err instanceof Error ? err.message : null);
      }
      return false;
    }
  }, [fail]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    addModeRef.current = addMode;
    const el = containerRef.current;
    if (el) el.style.cursor = addMode ? 'crosshair' : '';
    if (!addMode) return;
    // Escape leaves add mode, as the Cancel button does (D-18).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAddMode(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [addMode]);

  // Ticks the "Saved · 2 min ago" label while there is one to show.
  useEffect(() => {
    if (!savedAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [savedAt]);

  /**
   * Keeps the draft in step with the selected location without throwing work
   * away.
   *
   * This used to be `setDraft(toDraft(selected))` on every change of
   * `selected` — and `selected` is a fresh object after every reload, so a
   * photo upload, a drag of any pin, or saving anything reset a half-typed
   * form to the stored values with no warning (admin audit, 2026-10, C-10).
   * Now a different location gets a fresh draft, and the *same* location coming
   * back from the server keeps every field the person changed, taking the
   * server's value only for the fields they did not touch.
   */
  const prevSelectedRef = useRef<AdminPoi | null>(null);
  /** Set after a successful save: take the server's copy wholesale, since it
   *  may have normalised what was sent (trimmed a name, say). */
  const adoptServerRef = useRef(false);
  useEffect(() => {
    const prev = prevSelectedRef.current;
    prevSelectedRef.current = selected;
    if (selectedId === 'new') return; // the unsaved draft owns itself
    if (!selected) {
      setDraft(null);
      return;
    }
    const adopt = adoptServerRef.current;
    adoptServerRef.current = false;
    setDraft((d) => {
      if (adopt || !d || !prev || prev.id !== selected.id) return toDraft(selected);
      const before = toDraft(prev);
      const merged: Draft = toDraft(selected);
      for (const key of Object.keys(before) as (keyof Draft)[]) {
        if (!Object.is(d[key], before[key])) (merged as Record<keyof Draft, unknown>)[key] = d[key];
      }
      return merged;
    });
  }, [selected, selectedId]);

  /** Asks before unsaved work is thrown away. `true` means go ahead. */
  const confirmDiscard = useCallback((): boolean => {
    if (!dirtyRef.current) return true;
    const name = draftRef.current?.name.trim() || 'this location';
    return window.confirm(`Discard unsaved changes to "${name}"?`);
  }, []);

  /** Every change of selection goes through here: list, marker, back button. */
  const requestSelect = useCallback(
    (id: Selection) => {
      if (id === selectedIdRef.current) return;
      if (!confirmDiscard()) return;
      setSelectedId(id);
      clear();
    },
    [confirmDiscard, clear],
  );
  const requestSelectRef = useRef(requestSelect);
  useEffect(() => {
    requestSelectRef.current = requestSelect;
  });

  // --- add ------------------------------------------------------------------
  const startNewAt = useCallback(
    (lat: number, lng: number) => {
      if (!confirmDiscard()) return;
      setAddMode(false);
      setSelectedId('new');
      setDraft(newDraft(lat, lng));
      setFocusName((n) => n + 1);
      clear();
    },
    [confirmDiscard, clear],
  );
  const startNewAtRef = useRef(startNewAt);
  useEffect(() => {
    startNewAtRef.current = startNewAt;
  });

  /** The keyboard path to placing a pin (D-05): the middle of the map as it is
   *  framed now. The pin can then be dragged, or its coordinates typed. */
  const addAtCentre = () => {
    const c = mapRef.current?.getCenter();
    if (c) startNewAt(c.lat, c.lng);
  };

  // Focus the Name field once the form for a new location has rendered, with
  // its placeholder text selected so typing replaces it.
  useEffect(() => {
    if (focusName === 0) return;
    const el = nameRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusName]);

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
      if (addModeRef.current) startNewAtRef.current(e.latlng.lat, e.latlng.lng);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      newMarkerRef.current = null;
      newMarkerTypeRef.current = null;
      markersRef.current.clear();
    };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pois.filter((p) => {
      if (typeFilter !== 'all' && p.type !== typeFilter) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.slug.includes(q)) return false;
      return true;
    });
  }, [pois, query, typeFilter]);

  /** The current lists, readable from inside a Leaflet handler. */
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
      const label = `${poi.name}, ${TYPE_LABEL[poi.type]}${poi.is_campsite === 1 ? ', Campsite' : ''}${
        poi.status !== 'published' ? `, ${poi.status}` : ''
      }`;
      const marker = L.marker([poi.lat, poi.lng], {
        icon: poiIcon({
          type: poi.type,
          isCampsite: poi.is_campsite === 1,
          isMeetupSpot: poi.is_meetup_spot === 1,
          // The accessible name. Leaflet makes every keyboard marker a
          // `role="button"` tab stop, and `alt` only reaches an <img> icon —
          // this is a divIcon — so 104 pins were unnamed buttons (D-03).
          label,
        }),
        // The pointer user's tooltip, and Leaflet writes it on the element.
        title: poi.name,
        draggable: true,
        opacity: poi.status === 'published' ? 1 : 0.55,
      });

      marker.on('click', () => requestSelectRef.current(poi.id));

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
        const at = marker.getLatLng();
        // Rounded once and used for both the request and local state, so the
        // latitude field never shows 14 decimals that its 7-place `step`
        // then refuses on Save (admin audit, 2026-10, C-18).
        const lat = round7(at.lat);
        const lng = round7(at.lng);
        const name = poisRef.current.find((p) => p.id === poi.id)?.name ?? poi.name;
        try {
          await api(`/api/admin/pois/${poi.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ lat, lng }),
          });
          setPois((prev) => prev.map((p) => (p.id === poi.id ? { ...p, lat, lng } : p)));
          notify('ok', `Moved ${name}`);
        } catch (err) {
          marker.setLatLng(origin); // snap back on failure
          fail(err, 'Could not move');
        }
      });

      marker.addTo(layer);
      markersRef.current.set(poi.id, marker);
    }
  }, [markerKey, notify, fail]);

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

  // The unsaved new location's pin. Draggable like the others, but a drop only
  // moves the draft; nothing is written until Save.
  const newLat = isNew ? draft?.lat : undefined;
  const newLng = isNew ? draft?.lng : undefined;
  const newType = isNew ? draft?.type : undefined;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const placed =
      newLat !== undefined && newLng !== undefined && Number.isFinite(newLat) && Number.isFinite(newLng);
    if (!isNew || !placed || !newType) {
      newMarkerRef.current?.remove();
      newMarkerRef.current = null;
      newMarkerTypeRef.current = null;
      return;
    }
    const icon = () =>
      poiIcon({
        type: newType,
        isCampsite: false,
        isMeetupSpot: false,
        label: 'New location, not saved yet',
      });
    let marker = newMarkerRef.current;
    if (!marker) {
      marker = L.marker([newLat, newLng], { icon: icon(), draggable: true, title: 'New location' });
      marker.on('dragend', () => {
        const at = marker!.getLatLng();
        setDraft((d) => (d ? { ...d, lat: round7(at.lat), lng: round7(at.lng) } : d));
      });
      marker.addTo(map);
      newMarkerRef.current = marker;
      newMarkerTypeRef.current = newType;
    } else {
      const at = marker.getLatLng();
      if (Math.abs(at.lat - newLat) > 1e-9 || Math.abs(at.lng - newLng) > 1e-9) {
        marker.setLatLng([newLat, newLng]);
      }
      if (newMarkerTypeRef.current !== newType) {
        marker.setIcon(icon());
        newMarkerTypeRef.current = newType;
      }
    }
    marker.getElement()?.classList.add('is-selected');
  }, [isNew, newLat, newLng, newType]);

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
    if (typeof selectedId !== 'number') return;
    const poi = poisRef.current.find((p) => p.id === selectedId);
    if (poi) mapRef.current?.panTo([poi.lat, poi.lng]);
  }, [selectedId]);

  // On a phone the map pane's size changes when the list collapses (D-17);
  // Leaflet has to be told, or it keeps painting tiles for the old box.
  useEffect(() => {
    const t = window.setTimeout(() => mapRef.current?.invalidateSize(), 0);
    return () => window.clearTimeout(t);
  }, [selectedId]);

  // --- save / archive -------------------------------------------------------
  const save = useCallback(async () => {
    if (!draft) return;
    if (!isNew && !selected) return;
    // The coordinate fields are typed into, so they can be empty or half-typed.
    // Name the problem and the fix rather than sending NaN to the API.
    if (!Number.isFinite(draft.lat) || !Number.isFinite(draft.lng)) {
      notify('err', 'Latitude and longitude must both be numbers. Fill them in, or revert.');
      return;
    }
    const payload = {
      name: draft.name,
      type: draft.type,
      description: draft.description || null,
      lat: round7(draft.lat),
      lng: round7(draft.lng),
      status: draft.status,
      sponsor: draft.sponsor || null,
      isCampsite: draft.isCampsite,
      isMeetupSpot: draft.isMeetupSpot,
      isExEligible: draft.isExEligible,
    };
    setBusy(true);
    clear();
    try {
      let id: number;
      if (isNew) {
        const created = await api<{ id: number; slug: string }>('/api/admin/pois', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        id = created.id;
        await reload();
        setSelectedId(created.id);
        notify('ok', `Created ${draft.name}`);
      } else {
        id = selected!.id;
        await api(`/api/admin/pois/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        adoptServerRef.current = true;
        await reload();
        notify('ok', `Saved ${draft.name}`);
      }
      setSavedAt({ id, at: Date.now() });
      setNow(Date.now());
      // The Save button was disabled mid-request, which drops focus to <body>;
      // put it back on the form so the next Tab starts somewhere sensible.
      window.requestAnimationFrame(() => formHeadingRef.current?.focus());
    } catch (err) {
      fail(err, 'Could not save');
    } finally {
      setBusy(false);
    }
  }, [draft, isNew, selected, reload, notify, fail, clear]);

  const archive = useCallback(async () => {
    if (!selected) return;
    if (
      !window.confirm(
        `Archive "${selected.name}"? It disappears from the public map but stays recoverable.` +
          (dirtyRef.current ? ' Your unsaved changes to it will be lost.' : ''),
      )
    )
      return;
    setBusy(true);
    clear();
    try {
      await api(`/api/admin/pois/${selected.id}`, { method: 'DELETE' });
      await reload();
      setSelectedId(null);
      notify('ok', `Archived ${selected.name}`);
      window.requestAnimationFrame(() => hintHeadingRef.current?.focus());
    } catch (err) {
      fail(err, 'Could not archive');
    } finally {
      setBusy(false);
    }
  }, [selected, reload, notify, fail, clear]);

  /** Abandon an unsaved new location. */
  const discardNew = () => {
    if (!confirmDiscard()) return;
    setSelectedId(null);
    window.requestAnimationFrame(() => hintHeadingRef.current?.focus());
  };

  const uploadPhoto = useCallback(
    async (file: File) => {
      if (!selected) return;
      setUploading(true);
      clear();
      try {
        const body = new FormData();
        body.set('file', file);
        body.set('poiId', String(selected.id));
        body.set('name', selected.slug);
        body.set('alt', `${selected.name} — ${TYPE_LABEL[selected.type]}`);
        await api('/api/admin/media', { method: 'POST', body });
        // The reload brings back the new hero; the draft-sync effect above
        // keeps anything typed into the form meanwhile.
        await reload();
        notify('ok', 'Photo uploaded');
      } catch (err) {
        fail(err, 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [selected, reload, notify, fail, clear],
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

  const saveState = isNew
    ? 'Not saved yet'
    : dirty
      ? 'Unsaved changes'
      : savedAt && savedAt.id === selectedId
        ? `Saved · ${savedAgo(savedAt.at, now)}`
        : 'No unsaved changes';

  const formTitle = isNew ? 'New location' : (selected?.name ?? '');

  return (
    <div className={`editor${selectedId !== null ? ' has-selection' : ''}`}>
      <aside className="editor-list" aria-label="Locations">
        <div className="editor-list-head">
          <div className="editor-title-row">
            <h1 className="editor-title">Map editor</h1>
            {/* Phones only (D-17): with a location open the list collapses to
                this row so the map keeps its height. */}
            {selectedId !== null && (
              <button
                type="button"
                className="btn btn--outline btn--sm editor-back"
                onClick={() => requestSelect(null)}
              >
                Back to list
              </button>
            )}
          </div>
          <input
            type="search"
            placeholder="Search locations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search locations"
          />
          <div className="editor-filters" role="group" aria-label="Filter by type">
            <button
              type="button"
              className="chip"
              aria-pressed={typeFilter === 'all'}
              aria-label={`All, ${pois.length}`}
              onClick={() => setTypeFilter('all')}
            >
              All <span className="chip-count">{pois.length}</span>
            </button>
            {TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className="chip"
                aria-pressed={typeFilter === t}
                aria-label={`${TYPE_PLURAL[t]}, ${counts[t]}`}
                onClick={() => setTypeFilter(t)}
              >
                <span className={`chip-dot chip-dot--${t}`} aria-hidden="true" />
                {TYPE_PLURAL[t]} <span className="chip-count">{counts[t]}</span>
              </button>
            ))}
          </div>
          {counts.drafts > 0 && (
            <p className="editor-drafts">{counts.drafts} not published</p>
          )}
          {listTotal !== null && (
            <p className="editor-drafts">
              Showing {pois.length} of {listTotal} locations.
            </p>
          )}
        </div>

        {load !== 'ready' ? (
          <LoadNotice
            state={load}
            what="the locations"
            error={loadError}
            onRetry={() => {
              setLoad('loading');
              void reload();
            }}
          />
        ) : (
          <ul className="editor-items">
            {visible.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`editor-item${p.id === selectedId ? ' is-active' : ''}`}
                  aria-current={p.id === selectedId ? 'true' : undefined}
                  onClick={() => requestSelect(p.id)}
                >
                  <span className={`chip-dot chip-dot--${p.type}`} aria-hidden="true" />
                  <span className="editor-item-name">
                    {p.name}
                    <span className="sr-only">, {TYPE_LABEL[p.type]}</span>
                  </span>
                  {p.is_campsite === 1 && (
                    <>
                      <StarIcon className="editor-star" />
                      <span className="sr-only">, Campsite</span>
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
        )}
      </aside>

      <div className="editor-map-wrap">
        {/* Leaflet's container is a focusable scroll region with no name of its
            own; without this it is announced as an unlabelled group. */}
        <div ref={containerRef} className="editor-map" role="application" aria-label="Location map" />

        <div className="editor-toolbar">
          <button
            type="button"
            className="btn"
            aria-pressed={addMode}
            onClick={() => setAddMode((v) => !v)}
            disabled={busy}
          >
            {addMode ? 'Click the map to place…' : 'Add location'}
          </button>
          {addMode && (
            <>
              <button type="button" className="btn" onClick={addAtCentre}>
                Place at map centre
              </button>
              <button type="button" className="btn" onClick={() => setAddMode(false)}>
                Cancel
              </button>
            </>
          )}
        </div>

        <Toast message={message} onDismiss={clear} className="admin-toast--float" />
      </div>

      <aside className="editor-form" aria-label="Edit location">
        {!draft || (!selected && !isNew) ? (
          <div className="editor-hint">
            <h2 ref={hintHeadingRef} tabIndex={-1}>
              Nothing selected
            </h2>
            <p>
              Pick a location from the list or the map to edit it. Drag any pin to move it, or type
              its coordinates into the form.
            </p>
            <p>
              Press <strong>Add location</strong>, then click the map to place a new one, or choose{' '}
              <strong>Place at map centre</strong>. Nothing is saved until you press Save.
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
              <h2 ref={formHeadingRef} tabIndex={-1}>
                {formTitle}
              </h2>
              {selected ? (
                <code className="admin-code">{selected.slug}</code>
              ) : (
                <p className="form-head-note">Not saved yet. Drag the pin to adjust where it sits.</p>
              )}
            </header>

            <label>
              <span>
                Name <em>(required)</em>
              </span>
              <input
                ref={nameRef}
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
                required
                aria-required="true"
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
              <span>
                Description <em>(optional)</em>
              </span>
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
                <span>
                  Latitude <em>(required)</em>
                </span>
                <input
                  type="number"
                  step="0.0000001"
                  min={-90}
                  max={90}
                  inputMode="decimal"
                  required
                  aria-required="true"
                  value={Number.isFinite(draft.lat) ? draft.lat : ''}
                  onChange={(e) => set('lat', e.target.valueAsNumber)}
                />
              </label>
              <label>
                <span>
                  Longitude <em>(required)</em>
                </span>
                <input
                  type="number"
                  step="0.0000001"
                  min={-180}
                  max={180}
                  inputMode="decimal"
                  required
                  aria-required="true"
                  value={Number.isFinite(draft.lng) ? draft.lng : ''}
                  onChange={(e) => set('lng', e.target.valueAsNumber)}
                />
              </label>
              <p className="form-coords-hint">
                {isNew
                  ? 'Seven decimal places. Dragging the pin fills these in; nothing is saved until you press Create.'
                  : 'Seven decimal places. Dragging the pin on the map fills these in and saves straight away.'}
              </p>
            </div>

            <div className="form-photo">
              <span className="form-photo-label">Photo</span>
              {selected?.hero_key ? (
                <img src={`/media/${selected.hero_key}`} alt="" />
              ) : (
                <p className="form-photo-none">
                  {isNew ? 'Save the location first, then add a photo.' : 'No photo yet'}
                </p>
              )}
              {selected && (
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
              )}
            </div>

            <div className="form-actions">
              {/* The label never doubles as the status any more: it used to
                  read "Saved" while disabled, at ~3:1 (C-24 / D-21). The
                  state is printed beside it instead. */}
              <button type="submit" className="btn btn--primary btn--sm" disabled={!dirty || busy}>
                {busy ? 'Saving…' : isNew ? 'Create location' : 'Save changes'}
              </button>
              {isNew ? (
                <button
                  type="button"
                  className="btn btn--outline btn--sm"
                  onClick={discardNew}
                  disabled={busy}
                >
                  Discard
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={() => selected && setDraft(toDraft(selected))}
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
                </>
              )}
              <span className="admin-save-state" aria-live="polite">
                {saveState}
              </span>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
