import { useEffect, useState, type ComponentType } from 'react';

/**
 * SSR-safe, lazily-loaded wrapper around MapView for the home page.
 *
 * MapView cannot be server-rendered: Leaflet reads `window` at import time,
 * which is why /map mounts it with `client:only`. But `client:only` on the home
 * page would pull Leaflet, markercluster and the marker data into every single
 * visit, for a map most readers never scroll to.
 *
 * This wrapper has no module-scope Leaflet import, so it survives SSR and can
 * be mounted with `client:visible` — the dynamic import below does not run
 * until the island hydrates, which is when the preview actually scrolls into
 * view. The placeholder is styled inline because MapView.css arrives with that
 * same deferred chunk.
 */
type MapViewProps = { compact?: boolean; initialPoi?: string };

export default function MapPreview(props: MapViewProps) {
  const [MapView, setMapView] = useState<ComponentType<MapViewProps> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    import('./MapView')
      .then((mod) => {
        // setState with a function value needs the updater form, or React calls it.
        if (live) setMapView(() => mod.default);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  if (failed) {
    return (
      <div style={PLACEHOLDER} role="status">
        Map unavailable — <a href="/map">open the full map</a>
      </div>
    );
  }

  if (!MapView) {
    return (
      <div style={PLACEHOLDER} role="status">
        Loading map…
      </div>
    );
  }

  return <MapView {...props} />;
}

const PLACEHOLDER: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeContent: 'center',
  font: '600 0.86rem/1.4 inherit',
  color: 'var(--text-muted)',
};
