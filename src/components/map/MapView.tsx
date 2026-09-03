import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';

import type { MapData, MapPoi, PoiType } from '~/lib/db/map';
import { basemapLayer } from './basemap';
import { GLYPH_PATHS, GLYPH_VIEWBOX, photoIcon, poiIcon, TYPE_LABEL, userIcon } from './markerIcons';
import './MapView.css';

const TYPES: PoiType[] = ['pokestop', 'gym', 'powerspot'];

/** Remembers filter choices between visits — see loadPrefs. */
const PREFS_KEY = 'pogotxk.map.prefs';

interface LiveFlare {
  id: number;
  kind: string;
  boss: string | null;
  needed: number | null;
  note: string | null;
  expiresAt: string;
  poi: { id: number } | null;
}

interface Prefs {
  types: PoiType[];
  shapes: string[];
  campsiteOnly: boolean;
  photos: boolean;
}

/**
 * Filter state survives a reload, because the common case is someone who always
 * wants the same view — gyms only, route on — and re-picking it every visit is
 * a small tax paid forever.
 */
function loadPrefs(): Prefs | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    const types = (parsed.types ?? []).filter((t): t is PoiType => TYPES.includes(t as PoiType));
    return {
      // Never restore a state with everything hidden — that reads as a broken map.
      types: types.length ? types : TYPES,
      shapes: Array.isArray(parsed.shapes) ? parsed.shapes.filter((s) => typeof s === 'string') : [],
      campsiteOnly: parsed.campsiteOnly === true,
      // Photos are on unless the visitor turned them off, so a first visit shows
      // the park's own pictures.
      photos: parsed.photos !== false,
    };
  } catch {
    return null;
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* Private browsing, quota, or a locked-down browser. Not worth surfacing. */
  }
}

/** Great-circle distance in metres. */
function distanceMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/** Generous rather than tight — this is a phone on park wifi. */
const FETCH_TIMEOUT_MS = 12000;

/** How long the visible status row holds a message before it clears itself. */
const FLASH_MS = 9000;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Appends children to a DOM node.
 *
 * Deliberately not `parent.append(...)`: the Cloudflare Workers runtime types
 * declare their own `interface Element` (HTMLRewriter's) which merges with the
 * DOM one, and its directly-declared `append` shadows the inherited
 * `ParentNode.append`. `appendChild` has no such collision.
 */
function add(parent: Node, ...children: (Node | string)[]): void {
  for (const child of children) {
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/**
 * The popup's header strip: the type's colour, its silhouette and its word.
 *
 * This replaced a 4px coloured border along the popup's top edge. The border
 * tied the card to the pin you tapped by hue alone; the strip does the same job
 * and names the type as well, which is the site's own rule about colour never
 * being the only signal.
 */
function popupHead(modifier: string, label: string, glyph?: string): HTMLElement {
  const head = el('div', `popup-head popup-head--${modifier}`);
  if (glyph) {
    // Our own constant path data, never user text.
    head.innerHTML = `<svg class="popup-head-glyph" viewBox="${GLYPH_VIEWBOX}" width="13" height="15" aria-hidden="true" focusable="false"><path d="${glyph}"/></svg>`;
  }
  add(head, label);
  return head;
}

/**
 * Popup contents are built as real DOM rather than an HTML string so that user
 * text (names, captions, credits) is set via textContent and cannot inject
 * markup.
 */
function buildPoiPopup(
  poi: MapPoi,
  userPos: [number, number] | null,
  flare: LiveFlare | null,
  canFlare: boolean,
): HTMLElement {
  const root = el('div', 'popup');

  add(root, popupHead(poi.type, TYPE_LABEL[poi.type], GLYPH_PATHS[poi.type]));

  // Live activity goes above everything else — if something is happening here
  // right now, that is the only thing the reader cares about.
  if (flare) {
    const banner = el('div', 'popup-live');
    const minutes = Math.max(0, Math.round((Date.parse(flare.expiresAt) - Date.now()) / 60000));
    const headline = flare.boss
      ? `${flare.boss} raid`
      : flare.kind === 'remote_invites'
        ? `Remote invites${flare.needed ? `, needs ${flare.needed}` : ''}`
        : 'Active now';
    add(banner, el('strong', undefined, `● ${headline}`));
    add(banner, el('span', undefined, `${minutes} min left`));
    if (flare.note) add(banner, el('span', 'popup-live-note', flare.note));
    add(root, banner);
  }

  if (poi.photo) {
    const figure = el('figure', 'popup-figure figure');
    const img = el('img');
    img.src = `/media/${poi.photo.key}`;
    img.alt = poi.photo.alt ?? poi.name;
    img.loading = 'lazy';
    if (poi.photo.width && poi.photo.height) {
      img.width = poi.photo.width;
      img.height = poi.photo.height;
    }
    add(figure, img);

    // The credit rides on the image (a licensing obligation), on the shared
    // five-stop `.credit` ramp rather than the two-stop scrim this used to use.
    if (poi.photo.credit) {
      add(figure, el('figcaption', 'credit popup-credit', poi.photo.credit));
    }
    add(root, figure);
  }

  /*
   * Attribute badges only. "Gym" and "Campsite" are different kinds of fact —
   * the first is what this place *is*, and it now leads in the header strip;
   * the second is something the place happens to have.
   */
  if (poi.isCampsite || poi.isMeetupSpot) {
    const badges = el('div', 'popup-badges');
    if (poi.isCampsite) {
      add(badges, el('span', 'popup-badge popup-badge--attr-campsite', '★ Campsite'));
    }
    if (poi.isMeetupSpot) {
      add(badges, el('span', 'popup-badge popup-badge--attr-meetup', 'Meetup spot'));
    }
    add(root, badges);
  }

  /*
   * "Campsite - Welcoming", under a badge that already says ★ Campsite, spends
   * the card's most valuable line repeating the badge. Twenty-four POIs carry
   * that imported prefix; dropping it leaves the word that actually tells one
   * campsite from another.
   *
   * Display only — `poi.name` is untouched, so the admin editor, search and
   * the API all still show the stored name. Guarded on `isCampsite` so a place
   * genuinely named "Campsite Road" keeps its name.
   */
  const title = poi.isCampsite ? poi.name.replace(/^campsite\s*[-–—]\s*/i, '') : poi.name;
  add(root, el('h3', 'popup-title', title || poi.name));

  if (poi.description) add(root, el('p', 'popup-desc', poi.description));

  if (userPos) {
    const d = distanceMeters(userPos, [poi.lat, poi.lng]);
    add(root, el('p', 'popup-distance', `${formatDistance(d)} away`));
  }

  const actions = el('div', 'popup-actions');

  /*
   * Raising a flare from the map.
   *
   * The map is where people actually stand when something starts happening —
   * they have already found the gym and tapped its pin, which answers the only
   * question /go's form was going to ask them. So this hands over to /go with
   * the location pre-chosen rather than reimplementing the whole flare sheet
   * inside a Leaflet popup, where a boss picker and a note field would be
   * unusable on a phone and would fork logic that has to stay in step with the
   * POST /api/flares contract.
   *
   * First in the row, and the popup's one hot surface, because it is the reason
   * a signed-in member opened the pin.
   */
  if (canFlare) {
    const raise = el('a', 'btn btn--sm btn--arrow popup-action--flare');
    raise.href = `/go?poi=${encodeURIComponent(poi.slug)}`;
    raise.textContent = flare ? 'Manage the flare' : 'Flare this place';
    add(actions, raise);
  }

  // The two actions that leave for somewhere carry the signage arrow; Copy link
  // stays put, so it does not.
  const directions = el('a', 'btn btn--sm btn--primary btn--arrow');
  directions.href = `https://www.google.com/maps/dir/?api=1&destination=${poi.lat},${poi.lng}`;
  directions.target = '_blank';
  directions.rel = 'noopener noreferrer';
  directions.textContent = 'Directions';
  add(actions, directions);

  const share = el('button', 'btn btn--sm btn--outline', 'Copy link');
  share.type = 'button';
  share.addEventListener('click', async () => {
    const url = new URL(window.location.href);
    url.searchParams.set('poi', poi.slug);
    try {
      await navigator.clipboard.writeText(url.toString());
      share.textContent = 'Link copied';
      window.setTimeout(() => (share.textContent = 'Copy link'), 1600);
    } catch {
      share.textContent = 'Press Ctrl+C';
    }
  });
  add(actions, share);

  add(root, actions);

  if (poi.photo?.sourceUrl && poi.photo.sourceTitle) {
    const src = el('p', 'popup-source');
    const link = el('a');
    link.href = poi.photo.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = poi.photo.sourceTitle;
    add(src, 'Source: ', link);
    if (poi.photo.sourceDate) add(src, ` (${poi.photo.sourceDate})`);
    add(root, src);
  }

  return root;
}

interface MapViewProps {
  initialPoi?: string;
  /**
   * Embedded preview mode, for the home page.
   *
   * Same map, same markers, same popups — only the chrome is dropped. It is a
   * real map rather than a picture of one, because a screenshot that cannot be
   * panned is a worse answer to "where is this?" than the thing itself.
   *
   * Scroll-wheel zoom is off in this mode: an embedded map that swallows page
   * scroll traps anyone who flicks past it on the way down the page. Ctrl/⌘ +
   * wheel still zooms, which is the convention people already know from every
   * other embedded map.
   */
  compact?: boolean;
}

export default function MapView({ initialPoi, compact = false }: MapViewProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const markersRef = useRef(new Map<string, L.Marker>());
  const shapeLayersRef = useRef(new Map<string, L.Layer>());
  const userMarkerRef = useRef<L.Marker | null>(null);
  /** Community photo pins, held together so the Photos chip can drop them. */
  const photoLayerRef = useRef<L.LayerGroup | null>(null);
  /** Numbered badges shown along the raid route. */
  const routeOrderRef = useRef<L.LayerGroup | null>(null);
  /** Slug awaiting focus from a ?poi= deep link; cleared once opened. */
  const pendingFocusRef = useRef<string | null>(initialPoi ?? null);

  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Restored synchronously on first render so the map never flashes the default
  // filters before switching to the saved ones.
  const savedPrefs = useRef<Prefs | null>(typeof window === 'undefined' ? null : loadPrefs());
  const [activeTypes, setActiveTypes] = useState<Set<PoiType>>(
    new Set(savedPrefs.current?.types ?? TYPES),
  );
  const [activeShapes, setActiveShapes] = useState<Set<string>>(new Set());
  const [showCampsiteOnly, setShowCampsiteOnly] = useState(
    savedPrefs.current?.campsiteOnly ?? false,
  );
  const [showPhotos, setShowPhotos] = useState(savedPrefs.current?.photos ?? true);

  /** poiId -> the active flare on it, for the pulsing pins. */
  const [liveFlares, setLiveFlares] = useState<Map<number, LiveFlare>>(new Map());
  /**
   * Mirror of the above, read by popup builders.
   *
   * The popup callback closes over this ref rather than the state so that
   * marker bindings never need re-creating when flares change — rebuilding a
   * marker destroys any popup open on it, and flares refresh on a timer.
   */
  const liveFlaresRef = useRef(liveFlares);
  liveFlaresRef.current = liveFlares;

  /**
   * Whether the viewer may raise a flare, for the popup's "Flare this" action.
   *
   * Read from /api/me.json rather than passed down from the page, because this
   * component also renders inside the prerendered home page in `compact` mode,
   * where the server's idea of who is signed in is frozen at build time —
   * i.e. nobody, forever. A ref alongside the state so the popup builder can
   * read it without re-binding every marker; see the note on liveFlaresRef.
   */
  const [canFlare, setCanFlare] = useState(false);
  const canFlareRef = useRef(false);
  canFlareRef.current = canFlare;
  const [query, setQuery] = useState('');
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  /**
   * The same position as a ref, for exactly the reason liveFlaresRef exists:
   * the popup builder needs it, and having it in the marker-rebuild deps meant
   * pressing Locate tore down every marker and closed whatever popup was open.
   */
  const userPosRef = useRef<[number, number] | null>(null);
  userPosRef.current = userPos;
  const [locating, setLocating] = useState(false);
  /** Announced to assistive technology; the newest message stays put. */
  const [status, setStatus] = useState('');
  /** The visible twin, which clears itself so the panel does not keep stale news. */
  const [flash, setFlash] = useState('');
  const flashTimerRef = useRef(0);
  // Collapsed on phones, where an open panel covers most of the park.
  const [panelOpen, setPanelOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth > 640,
  );
  /** Stepped ellipsis for the loading state; see the note in MapView.css. */
  const [loadingDots, setLoadingDots] = useState(1);

  /**
   * Says something to everyone, not only to a screen reader.
   *
   * `announce` writes both regions; `setStatus` alone is for the running
   * filter count, which the panel already shows as a number and does not need
   * to shout.
   */
  const announce = useCallback((message: string) => {
    setStatus(message);
    setFlash(message);
    window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlash(''), FLASH_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(flashTimerRef.current), []);

  useEffect(() => {
    let cancelled = false;
    // Without the timeout, a fetch that never settles (a captive portal or a
    // proxy that accepts the connection and never answers, not a clean
    // failure) left `data` null forever — the render below has no branch for
    // that, so "Loading the park…" just sat there with no error and no retry,
    // indefinitely.
    fetch('/api/map.json', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      .then((r) => {
        if (!r.ok) throw new Error(`Map data unavailable (${r.status})`);
        return r.json() as Promise<MapData>;
      })
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => {
        if (cancelled) return;
        const message =
          e instanceof DOMException && e.name === 'TimeoutError'
            ? 'Map data is taking too long to load. Check your connection and try again.'
            : e instanceof Error
              ? e.message
              : 'Could not load the map.';
        setError(message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * The loading state's progress signal for anyone who has asked for reduced
   * motion. global.css freezes every animation, which stops the Poké Ball dead
   * and left the loader saying nothing at all. This ticks in React state rather
   * than CSS, so the kill does not reach it, and it is rendered inside an
   * `aria-hidden` span so the live region is not re-announced every second.
   */
  useEffect(() => {
    if (data || error) return;
    const id = window.setInterval(() => setLoadingDots((d) => (d % 3) + 1), 1000);
    return () => window.clearInterval(id);
  }, [data, error]);

  // --- live flares -----------------------------------------------------------
  // Polled as the baseline, with a WebSocket on top for immediacy. The poll is
  // not redundant: it is what makes expiry show up, since nothing broadcasts
  // when a flare simply runs out of time.
  useEffect(() => {
    let cancelled = false;

    const applyFlares = (flares: LiveFlare[]) => {
      if (cancelled) return;
      const next = new Map<number, LiveFlare>();
      for (const flare of flares) {
        if (flare.poi?.id != null) next.set(flare.poi.id, flare);
      }
      setLiveFlares(next);
    };

    const refresh = () =>
      fetch('/api/flares', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        .then((r) => (r.ok ? (r.json() as Promise<{ flares: LiveFlare[] }>) : null))
        .then((d) => d && applyFlares(d.flares ?? []))
        .catch(() => undefined);

    void refresh();
    const poll = window.setInterval(refresh, 60_000);

    let socket: WebSocket | null = null;
    try {
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${window.location.host}/api/flares/socket`);
      // Any board activity is a cue to re-read the authoritative list rather
      // than trying to merge deltas by hand.
      socket.onmessage = () => void refresh();
    } catch {
      /* Falls back to the poll. */
    }

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      socket?.close();
    };
  }, []);

  // Persist filters whenever they change.
  useEffect(() => {
    savePrefs({
      types: [...activeTypes],
      shapes: [...activeShapes],
      campsiteOnly: showCampsiteOnly,
      photos: showPhotos,
    });
  }, [activeTypes, activeShapes, showCampsiteOnly, showPhotos]);

  /** Slug -> POI, so the list, the deep link and the flare sync stop scanning. */
  const poiBySlug = useMemo(
    () => new Map((data?.pois ?? []).map((p) => [p.slug, p] as const)),
    [data],
  );

  const visiblePois = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.pois.filter((p) => {
      if (!activeTypes.has(p.type)) return false;
      if (showCampsiteOnly && !p.isCampsite) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, activeTypes, showCampsiteOnly, query]);

  /**
   * The same set, ordered for reading rather than for the map.
   *
   * Meetup spot first, then alphabetical — the same comparator the admin's
   * MeetupEditor already uses, so the one place staff pick a location and the
   * one place members browse them agree on the order.
   *
   * `numeric` matters more than it looks: several POIs are numbered holes on
   * the disc golf course, and a plain string sort puts "Hole #10" between
   * "Hole #1" and "Hole #2". `sensitivity: 'base'` keeps the order from
   * depending on capitalisation, which the imported names are inconsistent
   * about.
   */
  const listedPois = useMemo(
    () =>
      [...visiblePois].sort(
        (a, b) =>
          Number(b.isMeetupSpot) - Number(a.isMeetupSpot) ||
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      ),
    [visiblePois],
  );

  /**
   * Jump to a location from the list.
   *
   * The filter-clearing and the `pendingFocusRef` fallback are belt and braces,
   * not the usual path: the list only ever renders `visiblePois`, so a row that
   * can be clicked already has a marker. They cover the render before markers
   * exist, and any future caller that is not the list — a "nearest gym" action,
   * say — where the target genuinely could be filtered out. When that happens
   * the marker-sync effect picks the slug up the moment the marker is real,
   * which is exactly how `/map?poi=slug` already works.
   */
  const focusPoi = useCallback(
    (slug: string) => {
      const poi = poiBySlug.get(slug);
      if (!poi) return;

      setActiveTypes((prev) => (prev.has(poi.type) ? prev : new Set(prev).add(poi.type)));
      setShowCampsiteOnly((prev) => (prev && !poi.isCampsite ? false : prev));

      const marker = markersRef.current.get(slug);
      const cluster = clusterRef.current;
      const map = mapRef.current;
      if (!marker || !cluster || !map) {
        pendingFocusRef.current = slug;
        return;
      }

      // zoomToShowLayer first: a marker inside a collapsed cluster ignores
      // openPopup() outright. This is the bug that made deep links look broken.
      cluster.zoomToShowLayer(marker, () => {
        marker.openPopup();
        map.setView([poi.lat, poi.lng], Math.max(map.getZoom(), 18));
        announce(`Showing ${poi.name}.`);
      });
    },
    [poiBySlug, announce],
  );

  // --- initialise the map once data lands ---------------------------------
  useEffect(() => {
    if (!data || !containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: data.zone.center,
      zoom: data.zone.zoom,
      // Was supplied by the raster tile layer; now the map owns it, and the
      // vector basemap over-zooms past its own z15 data to reach it.
      maxZoom: 20,
      zoomControl: false,
      // See the `compact` prop: page scroll must not be hijacked by a map the
      // reader is only scrolling past. Leaflet still zooms on ctrl/⌘ + wheel.
      scrollWheelZoom: !compact,
    });
    mapRef.current = map;

    /*
     * The basemap is ALWAYS light, deliberately — it does not follow
     * `prefers-color-scheme` the way the rest of the site does.
     *
     * It used to swap to a dark basemap on an OS dark-mode match, on the
     * reasoning that a map which missed a mid-session theme change would be the
     * one thing on the page left behind. Justin reported the result as a bug: a
     * dark basemap does not read as "the site in dark mode", it reads as the map
     * being broken. Chrome and geography are not the same kind of surface —
     * panels, text and buttons are ours to theme, but the map is *content*, and
     * people match it against every other street map they have ever seen.
     *
     * The tiles are our own now — Protomaps vector tiles over OpenStreetMap
     * data, rendered in the browser with the `light` theme. The layer is built
     * in `basemap.ts` and MapEditor.tsx builds the same one, so the admin map
     * cannot drift.
     *
     * The one control that does NOT theme with the site is the attribution
     * pill: see MapView.css for why an 88%-opaque panel over a permanently
     * light map is not a colour.
     */
    basemapLayer().addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    if (data.zone.bounds) {
      // Less breathing room in the preview: 40px of padding is a small margin
      // in a full-viewport map and a third of the frame in a 4:3 card. Not
      // tighter than this, though — pins are anchored at their point and draw
      // upward, so a marker on the boundary clips against the top edge.
      map.fitBounds(data.zone.bounds, { padding: compact ? [26, 26] : [40, 40] });
    }

    const cluster = L.markerClusterGroup({
      maxClusterRadius: 45,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      // Below this the park is legible without grouping.
      disableClusteringAtZoom: 18,
      iconCreateFunction: (c) =>
        L.divIcon({
          // `.map-cluster`, not `.cluster` — the latter is a layout primitive,
          // and this unlayered file was overriding it site-wide.
          className: 'map-cluster-wrap',
          // The count alone announced as a bare number, which tells a screen
          // reader nothing about what it is or what pressing it does.
          html: `<span class="map-cluster" aria-hidden="true">${c.getChildCount()}</span><span class="sr-only">${c.getChildCount()} places, zoom in</span>`,
          iconSize: [38, 38],
        }),
    });
    clusterRef.current = cluster;
    map.addLayer(cluster);

    routeOrderRef.current = L.layerGroup();

    // Community photo pins sit outside the cluster — there are only nine and
    // they are a different kind of thing. Held in their own layer group so the
    // Photos chip can take them off the map; they used to be unfilterable.
    const photoLayer = L.layerGroup();
    photoLayerRef.current = photoLayer;
    for (const photo of data.communityPhotos) {
      const marker = L.marker([photo.lat, photo.lng], {
        icon: photoIcon(`${photo.alt ?? 'Community photo'} — community photo`),
        alt: photo.alt ?? 'Community photo',
      });
      const popup = el('div', 'popup');
      add(popup, popupHead('photo', 'Community photo'));
      const fig = el('figure', 'popup-figure figure');
      const img = el('img');
      img.src = `/media/${photo.key}`;
      img.alt = photo.alt ?? 'Community photo';
      img.loading = 'lazy';
      add(fig, img);
      if (photo.credit) add(fig, el('figcaption', 'credit popup-credit', photo.credit));
      add(popup, fig);
      if (photo.caption) add(popup, el('p', 'popup-desc', photo.caption));
      if (photo.sourceUrl && photo.sourceTitle) {
        const src = el('p', 'popup-source');
        const a = el('a');
        a.href = photo.sourceUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = photo.sourceTitle;
        add(src, 'Source: ', a);
        if (photo.sourceDate) add(src, ` (${photo.sourceDate})`);
        add(popup, src);
      }
      marker.bindPopup(popup, { maxWidth: 320 });
      marker.addTo(photoLayer);
    }

    // Overlay shapes (raid route, hotspot) — built now, added on toggle.
    for (const shape of data.shapes) {
      const style = (shape.style ?? {}) as L.PathOptions;
      const layer = L.geoJSON(shape.geojson as never, {
        style: () => style,
        interactive: false,
      });
      shapeLayersRef.current.set(shape.slug, layer);

      // A saved choice beats the zone default, including a deliberate "off".
      const saved = savedPrefs.current?.shapes;
      const visible = saved ? saved.includes(shape.slug) : shape.visibleByDefault;
      if (visible) {
        layer.addTo(map);
        setActiveShapes((prev) => new Set(prev).add(shape.slug));
      }
    }

    return () => {
      map.remove();
      mapRef.current = null;
      clusterRef.current = null;
      routeOrderRef.current = null;
      photoLayerRef.current = null;
      markersRef.current.clear();
      shapeLayersRef.current.clear();
    };
    // `compact` is a static prop in practice; listed because the effect reads it.
  }, [data, compact]);

  /*
   * Keep Leaflet's idea of the viewport in step with the element's.
   *
   * A map whose container is resized without `invalidateSize()` renders grey
   * bands where it thinks there is nothing — which happens on every device
   * rotation, on the home page when the board reflows around the preview, and
   * whenever the browser's URL bar collapses.
   *
   * The same observer measures the two strips the chrome has to reserve. The
   * attribution's height is a licence obligation expressed in pixels: the
   * filter panel is pinned above it, and the credit wraps to a second line on a
   * narrow phone, so this is measured rather than assumed.
   */
  useEffect(() => {
    const shell = shellRef.current;
    const container = containerRef.current;
    const map = mapRef.current;
    if (!shell || !container || !map) return;

    const attribution = container.querySelector<HTMLElement>('.leaflet-control-attribution');
    const panel = panelRef.current;

    const sync = () => {
      map.invalidateSize();
      if (attribution) {
        const h = Math.ceil(attribution.getBoundingClientRect().height);
        if (h > 0) shell.style.setProperty('--map-attrib-h', `${h}px`);
      }
      shell.style.setProperty(
        '--map-panel-h',
        panel ? `${Math.ceil(panel.getBoundingClientRect().height)}px` : '0px',
      );
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    if (attribution) observer.observe(attribution);
    if (panel) observer.observe(panel);
    return () => observer.disconnect();
  }, [data, panelOpen]);

  // --- community photo pins on or off ---------------------------------------
  // Dropped while a text search is running: the search filters places by name,
  // and photo pins carry no name to match, so leaving them up makes a filtered
  // map look unfiltered.
  useEffect(() => {
    const map = mapRef.current;
    const layer = photoLayerRef.current;
    if (!map || !layer) return;
    const wanted = showPhotos && query.trim() === '';
    if (wanted) layer.addTo(map);
    else map.removeLayer(layer);
  }, [showPhotos, query, data]);

  // --- sync markers to the current filter ---------------------------------
  useEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster || !data) return;

    cluster.clearLayers();
    markersRef.current.clear();

    const layers: L.Marker[] = [];
    for (const poi of visiblePois) {
      const flare = liveFlaresRef.current.get(poi.id) ?? null;
      const marker = L.marker([poi.lat, poi.lng], {
        icon: poiIcon({
          type: poi.type,
          isCampsite: poi.isCampsite,
          isMeetupSpot: poi.isMeetupSpot,
          isLive: flare !== null,
          // The name has to go *inside* the icon markup. `alt` below only lands
          // on an <img> icon, and these are divIcons — so every pin was a
          // focusable role="button" with no accessible name at all.
          label: pinLabel(poi, flare !== null),
        }),
        // Kept for the non-divIcon path and as documentation of intent.
        alt: pinLabel(poi, flare !== null),
        keyboard: true,
        riseOnHover: true,
        // A gym with something happening on it should sit above its neighbours.
        zIndexOffset: flare ? 1000 : 0,
      });
      // Reads the refs, so the popup is current without re-binding on every
      // flare refresh or location fix.
      marker.bindPopup(
        () =>
          buildPoiPopup(
            poi,
            userPosRef.current,
            liveFlaresRef.current.get(poi.id) ?? null,
            canFlareRef.current,
          ),
        { maxWidth: 320, minWidth: 240 },
      );
      markersRef.current.set(poi.slug, marker);
      layers.push(marker);
    }
    cluster.addLayers(layers);

    const total = data.pois.length;
    setStatus(
      visiblePois.length === total
        ? `Showing all ${total} locations.`
        : `Showing ${visiblePois.length} of ${total} locations.`,
    );

    // Focus a deep-linked POI here, not on a timer. Every filter change rebuilds
    // these marker instances, so a deferred lookup can end up holding a marker
    // that is no longer on the map — and a marker still inside a collapsed
    // cluster ignores openPopup() outright. Doing it immediately after
    // addLayers guarantees the marker is live, and zoomToShowLayer expands the
    // cluster around it first.
    const wanted = pendingFocusRef.current;
    if (!wanted) return;

    const marker = markersRef.current.get(wanted);
    if (!marker) return; // filtered out; the effect that re-enables its type will re-run us

    pendingFocusRef.current = null;
    const map = mapRef.current;
    cluster.zoomToShowLayer(marker, () => {
      marker.openPopup();
      const poi = poiBySlug.get(wanted);
      if (poi) map?.setView([poi.lat, poi.lng], Math.max(map.getZoom(), 18));
      setStatus(`Showing ${poi?.name ?? wanted}.`);
    });
    // Deliberately NOT depending on liveFlares or userPos: rebuilding markers
    // destroys any popup open on them, flares refresh on a timer and pressing
    // Locate would otherwise close the popup the reader was standing in front
    // of. Both are read from refs above; the effects below refresh open popups
    // in place instead.
  }, [visiblePois, data, poiBySlug]);

  // --- reflect flare changes without rebuilding markers ----------------------
  useEffect(() => {
    if (!data) return;

    for (const [slug, marker] of markersRef.current) {
      const poi = poiBySlug.get(slug);
      if (!poi) continue;

      const isLive = liveFlares.has(poi.id);
      // `_pogoLive` tracks what the icon currently shows, so an unchanged
      // marker is left completely alone — setIcon would otherwise replace the
      // DOM element and close its popup.
      const marked = marker as L.Marker & { _pogoLive?: boolean };
      if (marked._pogoLive === isLive) continue;

      marked._pogoLive = isLive;
      marker.setIcon(
        poiIcon({
          type: poi.type,
          isCampsite: poi.isCampsite,
          isMeetupSpot: poi.isMeetupSpot,
          isLive,
          // `setIcon` replaces the icon's whole DOM, so omitting the label here
          // would silently strip the accessible name off any pin the moment a
          // flare went up or came down — the pins most worth reaching.
          label: pinLabel(poi, isLive),
        }),
      );
      marker.setZIndexOffset(isLive ? 1000 : 0);

      // A popup already on screen was built before this flare was known — a
      // deep link opens one before the first fetch resolves. Re-run its content
      // function so the banner appears rather than requiring a close/reopen.
      if (marker.isPopupOpen()) marker.getPopup()?.update();
    }
  }, [liveFlares, data, poiBySlug, visiblePois]);

  // --- who is looking, for the "Flare this" action ---------------------------
  // Guests and signed-out visitors never see it: the POST would be refused by
  // requireRole('member'), and an action that cannot succeed is worse than no
  // action. `compact` is the home-page preview, which is a picture of the park
  // rather than a place to act.
  useEffect(() => {
    if (compact) return;
    let cancelled = false;
    fetch('/api/me.json', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ user: { role?: string } | null }>) : null))
      .then((d) => {
        if (cancelled) return;
        const role = d?.user?.role;
        setCanFlare(role === 'member' || role === 'ambassador' || role === 'admin');
      })
      .catch(() => {
        /* Signed-out is the safe assumption, and it is already the default. */
      });
    return () => {
      cancelled = true;
    };
  }, [compact]);

  // A popup opened before /api/me.json resolved was built without the action,
  // and one opened before Locate ran was built without the distance line. Same
  // fix for both: re-run the content function in place rather than making the
  // trainer close and reopen the pin.
  useEffect(() => {
    for (const marker of markersRef.current.values()) {
      if (marker.isPopupOpen()) marker.getPopup()?.update();
    }
  }, [canFlare, userPos]);

  // --- numbered walking order along the raid route --------------------------
  // The route is a bare polyline: it shows you the shape of the walk but not
  // which gym comes next, which is the thing you actually want while walking
  // it. Numbering each gym by how far along the route it sits turns the line
  // into an itinerary.
  useEffect(() => {
    const map = mapRef.current;
    const orderLayer = routeOrderRef.current;
    if (!map || !orderLayer || !data) return;

    orderLayer.clearLayers();
    if (!activeShapes.has('raid-route')) {
      map.removeLayer(orderLayer);
      return;
    }

    const route = data.shapes.find((s) => s.slug === 'raid-route');
    const geo = route?.geojson as { coordinates?: [number, number][] } | undefined;
    const path = geo?.coordinates;
    if (!path?.length) return;

    // Position along the route = index of the nearest vertex. Crude versus true
    // arc-length projection, but the vertices are metres apart so it orders
    // identically and costs nothing.
    const positionOf = (lat: number, lng: number): { index: number; distance: number } => {
      let bestIndex = 0;
      let best = Infinity;
      path.forEach(([plng, plat], index) => {
        const d = (plat - lat) ** 2 + (plng - lng) ** 2;
        if (d < best) {
          best = d;
          bestIndex = index;
        }
      });
      return { index: bestIndex, distance: Math.sqrt(best) };
    };

    // ~120 m in degrees. Gyms further than this from the line are not on the
    // walk and should not be numbered into it.
    const MAX_OFFSET = 0.0012;

    const ordered = visiblePois
      .filter((p) => p.type === 'gym')
      .map((poi) => ({ poi, ...positionOf(poi.lat, poi.lng) }))
      .filter((entry) => entry.distance <= MAX_OFFSET)
      .sort((a, b) => a.index - b.index);

    ordered.forEach((entry, i) => {
      L.marker([entry.poi.lat, entry.poi.lng], {
        icon: L.divIcon({
          className: 'pin-wrap',
          html: `<span class="route-step">${i + 1}</span>`,
          iconSize: [22, 22],
          // Offset up-left so it badges the pin rather than covering it.
          iconAnchor: [30, 46],
        }),
        interactive: false,
        keyboard: false,
      }).addTo(orderLayer);
    });

    orderLayer.addTo(map);
  }, [activeShapes, data, visiblePois]);

  // --- deep link: /map?poi=slug -------------------------------------------
  // Only clears a filter that would hide the target; the focus itself happens
  // in the marker-sync effect above once the marker actually exists.
  useEffect(() => {
    if (!initialPoi) return;
    const poi = poiBySlug.get(initialPoi);
    if (!poi) return;
    setActiveTypes((prev) => (prev.has(poi.type) ? prev : new Set(prev).add(poi.type)));
    setShowCampsiteOnly((prev) => (prev && !poi.isCampsite ? false : prev));
  }, [initialPoi, poiBySlug]);

  const toggleType = useCallback((type: PoiType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      // Never leave the map empty by filtering everything out.
      return next.size === 0 ? new Set(TYPES) : next;
    });
  }, []);

  const toggleShape = useCallback((slug: string) => {
    const map = mapRef.current;
    const layer = shapeLayersRef.current.get(slug);
    if (!map || !layer) return;

    setActiveShapes((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        map.removeLayer(layer);
        next.delete(slug);
      } else {
        layer.addTo(map);
        next.add(slug);
      }
      return next;
    });
  }, []);

  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      announce('This browser cannot share your location. Pick a place from the list instead.');
      return;
    }
    setLocating(true);
    announce('Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const here: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setUserPos(here);
        const map = mapRef.current;
        if (!map) return;

        userMarkerRef.current?.remove();
        userMarkerRef.current = L.marker(here, { icon: userIcon(), interactive: false }).addTo(map);
        map.setView(here, Math.max(map.getZoom(), 17));

        const gyms = (data?.pois ?? []).filter((p) => p.type === 'gym');
        if (gyms.length) {
          const nearest = gyms.reduce((best, p) =>
            distanceMeters(here, [p.lat, p.lng]) < distanceMeters(here, [best.lat, best.lng])
              ? p
              : best,
          );
          announce(
            `You are here. Nearest gym: ${nearest.name}, ${formatDistance(
              distanceMeters(here, [nearest.lat, nearest.lng]),
            )} away.`,
          );
        } else {
          announce('You are here.');
        }
      },
      (err) => {
        setLocating(false);
        // Name the problem and the way out of it, rather than repeating the
        // browser's own string.
        const message =
          err.code === err.PERMISSION_DENIED
            ? 'Location is blocked for this site. Turn it on in your browser settings, or pick a place from the list.'
            : err.code === err.TIMEOUT
              ? 'Finding your location took too long. Try again, or pick a place from the list.'
              : 'Could not get your location. Move somewhere with a clearer view of the sky and try again.';
        announce(message);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  }, [data, announce]);

  if (error) {
    return (
      <div className="map-error" role="alert">
        <p>{error}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      className={`map-shell${compact ? ' map-shell--compact' : ''}`}
      aria-busy={!data}
    >
      <div
        ref={containerRef}
        className="map-canvas"
        aria-label="Map of Spring Lake Park Pokémon GO locations"
        role="application"
      />

      {!data && (
        <div className="map-loading" role="status">
          <span className="map-loading-ball" aria-hidden="true">
            {/* A Poké Ball, turning. Fixed brand colours rather than tokens so it
                reads the same on the always-light map ground in either theme;
                global reduced-motion freezes the spin to a resting ball, which
                is why the words carry a stepped ellipsis of their own. */}
            <svg viewBox="0 0 44 44" width="40" height="40" aria-hidden="true" focusable="false">
              <circle cx="22" cy="22" r="20" fill="#fff" stroke="#0f0f11" strokeWidth="2.5" />
              <path d="M2 22a20 20 0 0 1 40 0Z" fill="#c8071c" />
              <rect x="3" y="20" width="38" height="4" fill="#0f0f11" />
              <circle cx="22" cy="22" r="6" fill="#fff" stroke="#0f0f11" strokeWidth="2.5" />
            </svg>
          </span>
          <span>
            Loading the park
            <span className="map-loading-dots" aria-hidden="true">
              {'.'.repeat(loadingDots)}
            </span>
          </span>
        </div>
      )}

      {!compact && (
        <button
          type="button"
          className="map-locate"
          onClick={locate}
          aria-busy={locating}
          title="Show my location"
          aria-label="Show my location"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8.94 3A9 9 0 0 0 13 3.06V1h-2v2.06A9 9 0 0 0 3.06 11H1v2h2.06A9 9 0 0 0 11 20.94V23h2v-2.06A9 9 0 0 0 20.94 13H23v-2ZM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14"
            />
          </svg>
        </button>
      )}

      {!compact && (
        <section
          ref={panelRef}
          className="map-panel panel panel--flush"
          aria-label="Map legend and filters"
        >
          {flash && <p className="map-status">{flash}</p>}

          <button
            type="button"
            className="panel-handle"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            Legend
            <span className="sr-only"> and filters</span>
            <span className="panel-chevron" aria-hidden="true">
              ▾
            </span>
          </button>

          {/* The key stays out of the fold: a legend you have to open is not a
              legend. Hue, silhouette and word on every row. */}
          <ul className="map-legend">
            {TYPES.map((type) => (
              <li key={type} className="legend-item">
                <span className={`chip-dot chip-dot--${type}`} aria-hidden="true" />
                <svg
                  className="legend-glyph"
                  viewBox={GLYPH_VIEWBOX}
                  width="12"
                  height="14"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d={GLYPH_PATHS[type]} />
                </svg>
                {TYPE_LABEL[type]}
              </li>
            ))}
          </ul>

          <div className="panel-body" hidden={!panelOpen}>
            <label className="map-search">
              <span className="sr-only">Search locations by name</span>
              <input
                type="search"
                placeholder="Search locations…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>

            <div className="filter-row" role="group" aria-label="Filter by location type">
              {TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`chip chip--${type}`}
                  aria-pressed={activeTypes.has(type)}
                  onClick={() => toggleType(type)}
                >
                  <span className={`chip-dot chip-dot--${type}`} aria-hidden="true" />
                  {TYPE_LABEL[type]}
                  {data && <span className="chip-count">{data.counts[type]}</span>}
                </button>
              ))}
            </div>

            <div className="filter-row" role="group" aria-label="Map overlays">
              <button
                type="button"
                className="chip chip--campsite"
                aria-pressed={showCampsiteOnly}
                onClick={() => setShowCampsiteOnly((v) => !v)}
              >
                <span aria-hidden="true">★</span> Campsite only
              </button>
              <button
                type="button"
                className="chip chip--photos"
                aria-pressed={showPhotos}
                onClick={() => setShowPhotos((v) => !v)}
              >
                Photos
                {data && <span className="chip-count">{data.communityPhotos.length}</span>}
              </button>
              {(data?.shapes ?? []).map((shape) => (
                <button
                  key={shape.slug}
                  type="button"
                  className={`chip chip--${shape.slug}`}
                  aria-pressed={activeShapes.has(shape.slug)}
                  onClick={() => toggleShape(shape.slug)}
                >
                  {shape.name}
                </button>
              ))}
            </div>

            {/*
              Every location, listed. At 104 there is no reason to make anyone hunt
              for a pin — the list is short enough to read end to end, and it is
              the only way to find a place by name without knowing where it sits.

              It shows what the map shows: the search box and the type chips above
              filter both, so the count below is always the answer to "how many am
              I looking at".
            */}
            <div className="poi-list-head">
              <h2>Locations</h2>
              <span className="poi-count">
                {data && visiblePois.length === data.pois.length
                  ? `all ${data.pois.length}`
                  : `${visiblePois.length} of ${data?.pois.length ?? 0}`}
              </span>
            </div>

            {listedPois.length === 0 ? (
              <p className="poi-empty">No locations match that search.</p>
            ) : (
              <ul className="poi-list">
                {listedPois.map((poi) => (
                  <li key={poi.slug}>
                    <button type="button" className="poi-row" onClick={() => focusPoi(poi.slug)}>
                      <span className={`chip-dot chip-dot--${poi.type}`} aria-hidden="true" />
                      <span className="poi-row-name">{poi.name}</span>
                      {poi.isMeetupSpot && <span className="poi-row-tag">Meetup spot</span>}
                      <span className="poi-row-type">{TYPE_LABEL[poi.type]}</span>
                      {poi.isCampsite && (
                        <span className="poi-row-star" aria-label="Campsite">
                          ★
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Tile attribution deliberately lives in Leaflet's own control, not
                here — it has to stay visible whether or not this panel is open,
                and the panel reserves its height so it is never covered. */}
          </div>
        </section>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

/**
 * A pin's accessible name.
 *
 * The flare is part of it: a pulsing red ring is the only thing that marks a
 * live pin on screen, and neither the pulse nor the ring reaches a screen
 * reader.
 */
function pinLabel(poi: MapPoi, isLive: boolean): string {
  const base = `${poi.name} — ${TYPE_LABEL[poi.type]}`;
  return isLive ? `${base}, active flare` : base;
}
