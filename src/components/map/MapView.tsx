import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';

import type { MapData, MapPoi, PoiType } from '~/lib/db/map';
import { photoIcon, poiIcon, TYPE_LABEL, userIcon } from './markerIcons';
import './MapView.css';

const TYPES: PoiType[] = ['pokestop', 'gym', 'powerspot'];

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
 * Popup contents are built as real DOM rather than an HTML string so that user
 * text (names, captions, credits) is set via textContent and cannot inject
 * markup.
 */
function buildPoiPopup(poi: MapPoi, userPos: [number, number] | null): HTMLElement {
  const root = el('div', 'popup');

  if (poi.photo) {
    const figure = el('figure', 'popup-figure');
    const img = el('img');
    img.src = `/media/${poi.photo.key}`;
    img.alt = poi.photo.alt ?? poi.name;
    img.loading = 'lazy';
    if (poi.photo.width && poi.photo.height) {
      img.width = poi.photo.width;
      img.height = poi.photo.height;
    }
    add(figure, img);

    if (poi.photo.credit) {
      add(figure, el('figcaption', 'popup-credit', poi.photo.credit));
    }
    add(root, figure);
  }

  const badges = el('div', 'popup-badges');
  const typeBadge = el('span', `popup-badge popup-badge--${poi.type}`, TYPE_LABEL[poi.type]);
  add(badges, typeBadge);
  if (poi.isCampsite) add(badges, el('span', 'popup-badge popup-badge--campsite', '★ Campsite'));
  if (poi.isMeetupSpot) add(badges, el('span', 'popup-badge popup-badge--meetup', 'Meetup spot'));
  add(root, badges);

  add(root, el('h3', 'popup-title', poi.name));

  if (poi.description) add(root, el('p', 'popup-desc', poi.description));

  if (userPos) {
    const d = distanceMeters(userPos, [poi.lat, poi.lng]);
    add(root, el('p', 'popup-distance', `${formatDistance(d)} away`));
  }

  const actions = el('div', 'popup-actions');

  const directions = el('a', 'popup-action');
  directions.href = `https://www.google.com/maps/dir/?api=1&destination=${poi.lat},${poi.lng}`;
  directions.target = '_blank';
  directions.rel = 'noopener noreferrer';
  directions.textContent = 'Directions';
  add(actions, directions);

  const share = el('button', 'popup-action popup-action--ghost', 'Copy link');
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

export default function MapView({ initialPoi }: { initialPoi?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const markersRef = useRef(new Map<string, L.Marker>());
  const shapeLayersRef = useRef(new Map<string, L.Layer>());
  const userMarkerRef = useRef<L.Marker | null>(null);
  /** Slug awaiting focus from a ?poi= deep link; cleared once opened. */
  const pendingFocusRef = useRef<string | null>(initialPoi ?? null);

  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTypes, setActiveTypes] = useState<Set<PoiType>>(new Set(TYPES));
  const [activeShapes, setActiveShapes] = useState<Set<string>>(new Set());
  const [showCampsiteOnly, setShowCampsiteOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  const [status, setStatus] = useState('');
  // Collapsed on phones, where an open panel covers most of the park.
  const [panelOpen, setPanelOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth > 640,
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/map.json')
      .then((r) => {
        if (!r.ok) throw new Error(`Map data unavailable (${r.status})`);
        return r.json() as Promise<MapData>;
      })
      .then((d) => !cancelled && setData(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

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

  // --- initialise the map once data lands ---------------------------------
  useEffect(() => {
    if (!data || !containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: data.zone.center,
      zoom: data.zone.zoom,
      zoomControl: false,
    });
    mapRef.current = map;

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    if (data.zone.bounds) {
      map.fitBounds(data.zone.bounds, { padding: [40, 40] });
    }

    const cluster = L.markerClusterGroup({
      maxClusterRadius: 45,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      // Below this the park is legible without grouping.
      disableClusteringAtZoom: 18,
      iconCreateFunction: (c) =>
        L.divIcon({
          className: 'cluster-wrap',
          html: `<span class="cluster">${c.getChildCount()}</span>`,
          iconSize: [38, 38],
        }),
    });
    clusterRef.current = cluster;
    map.addLayer(cluster);

    // Community photo pins sit outside the cluster — there are only nine and
    // they are a different kind of thing.
    for (const photo of data.communityPhotos) {
      const marker = L.marker([photo.lat, photo.lng], {
        icon: photoIcon(),
        alt: photo.alt ?? 'Community photo',
      });
      const popup = el('div', 'popup');
      const fig = el('figure', 'popup-figure');
      const img = el('img');
      img.src = `/media/${photo.key}`;
      img.alt = photo.alt ?? 'Community photo';
      img.loading = 'lazy';
      add(fig, img);
      if (photo.credit) add(fig, el('figcaption', 'popup-credit', photo.credit));
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
      marker.addTo(map);
    }

    // Overlay shapes (raid route, hotspot) — built now, added on toggle.
    for (const shape of data.shapes) {
      const style = (shape.style ?? {}) as L.PathOptions;
      const layer = L.geoJSON(shape.geojson as never, {
        style: () => style,
        interactive: false,
      });
      shapeLayersRef.current.set(shape.slug, layer);
      if (shape.visibleByDefault) {
        layer.addTo(map);
        setActiveShapes((prev) => new Set(prev).add(shape.slug));
      }
    }

    return () => {
      map.remove();
      mapRef.current = null;
      clusterRef.current = null;
      markersRef.current.clear();
      shapeLayersRef.current.clear();
    };
  }, [data]);

  // --- sync markers to the current filter ---------------------------------
  useEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster || !data) return;

    cluster.clearLayers();
    markersRef.current.clear();

    const layers: L.Marker[] = [];
    for (const poi of visiblePois) {
      const marker = L.marker([poi.lat, poi.lng], {
        icon: poiIcon({
          type: poi.type,
          isCampsite: poi.isCampsite,
          isMeetupSpot: poi.isMeetupSpot,
        }),
        // Screen readers announce this; keyboard users can tab to the marker.
        alt: `${poi.name} — ${TYPE_LABEL[poi.type]}`,
        keyboard: true,
        riseOnHover: true,
      });
      marker.bindPopup(() => buildPoiPopup(poi, userPos), { maxWidth: 320, minWidth: 240 });
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
      const poi = data.pois.find((p) => p.slug === wanted);
      if (poi) map?.setView([poi.lat, poi.lng], Math.max(map.getZoom(), 18));
      setStatus(`Showing ${poi?.name ?? wanted}.`);
    });
  }, [visiblePois, data, userPos]);

  // --- deep link: /map?poi=slug -------------------------------------------
  // Only clears a filter that would hide the target; the focus itself happens
  // in the marker-sync effect above once the marker actually exists.
  useEffect(() => {
    if (!initialPoi || !data) return;
    const poi = data.pois.find((p) => p.slug === initialPoi);
    if (!poi) return;
    setActiveTypes((prev) => (prev.has(poi.type) ? prev : new Set(prev).add(poi.type)));
    setShowCampsiteOnly((prev) => (prev && !poi.isCampsite ? false : prev));
  }, [initialPoi, data]);

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
      setStatus('Location is not available in this browser.');
      return;
    }
    setStatus('Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
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
          setStatus(
            `You are here. Nearest gym: ${nearest.name}, ${formatDistance(
              distanceMeters(here, [nearest.lat, nearest.lng]),
            )} away.`,
          );
        } else {
          setStatus('You are here.');
        }
      },
      (err) => setStatus(`Could not get your location: ${err.message}`),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  }, [data]);

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
    <div className="map-shell">
      <div ref={containerRef} className="map-canvas" aria-label="Map of Spring Lake Park Pokémon GO locations" role="application" />

      {!data && <div className="map-loading">Loading map…</div>}

      <button
        type="button"
        className="map-locate"
        onClick={locate}
        title="Show my location"
        aria-label="Show my location"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8.94 3A9 9 0 0 0 13 3.06V1h-2v2.06A9 9 0 0 0 3.06 11H1v2h2.06A9 9 0 0 0 11 20.94V23h2v-2.06A9 9 0 0 0 20.94 13H23v-2ZM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14"
          />
        </svg>
      </button>

      <section className={`map-panel${panelOpen ? '' : ' map-panel--closed'}`} aria-label="Map filters">
        <button
          type="button"
          className="panel-handle"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((v) => !v)}
        >
          <span className="panel-grip" aria-hidden="true" />
          <strong>Map Filters</strong>
        </button>

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

          {/* Tile attribution deliberately lives in Leaflet's own control, not
              here — it has to stay visible whether or not this panel is open. */}
        </div>
      </section>

      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
