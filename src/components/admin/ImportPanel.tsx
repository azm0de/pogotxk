import { useCallback, useState } from 'react';
import './ImportPanel.css';

interface Props {
  /** Server-rendered starting state, so the panel is useful before any click. */
  poiCount: number;
  mediaCount: number;
}

interface LegacyResult {
  ok?: boolean;
  error?: string;
  hint?: string;
  pois?: { total: number; byType: Record<string, number>; campsite: number; meetupSpot: number };
  media?: { rows: number; photos: number; communityPhotos: number; withCredit: number };
  shapes?: { raidRoutePoints: number; hotspotPoints: number };
  warnings?: string[];
}

interface MediaResult {
  ok?: boolean;
  error?: string;
  total?: number;
  uploaded?: number;
  alreadyPresent?: number;
  remaining?: number;
  done?: boolean;
  failed?: { key: string; reason: string }[];
}

type Phase = 'idle' | 'metadata' | 'media' | 'done' | 'error';

/** Media runs in passes because a Worker's outbound request budget is finite. */
const MEDIA_BATCH = 30;
const MAX_PASSES = 12;

export default function ImportPanel({ poiCount, mediaCount }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [needsForce, setNeedsForce] = useState(false);
  const [uploaded, setUploaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<LegacyResult | null>(null);

  const say = useCallback((line: string) => setLog((l) => [...l, line]), []);

  const post = async <T,>(url: string): Promise<T> => {
    const res = await fetch(url, {
      method: 'POST',
      // Astro rejects cross-site form-shaped POSTs; this marks it as an API call.
      headers: { 'content-type': 'application/json' },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok && res.status !== 409) {
      throw Object.assign(new Error(body.error ?? res.statusText), { status: res.status, body });
    }
    return Object.assign(body, { __status: res.status }) as T;
  };

  const run = useCallback(
    async (force: boolean) => {
      setPhase('metadata');
      setError(null);
      setNeedsForce(false);
      setLog([]);
      setUploaded(0);
      setTotal(0);
      setSummary(null);

      try {
        say('Reading markers.js, script.js and meetup.js from pokemontxk.com…');
        const meta = await post<LegacyResult & { __status: number }>(
          `/api/admin/import-legacy${force ? '?force=1' : ''}`,
        );

        if (meta.__status === 409) {
          setNeedsForce(true);
          setPhase('idle');
          say(meta.error ?? 'Database already contains POIs.');
          return;
        }

        setSummary(meta);
        say(
          `Imported ${meta.pois?.total ?? 0} locations ` +
            `(${meta.pois?.byType.pokestop ?? 0} stops, ${meta.pois?.byType.gym ?? 0} gyms, ` +
            `${meta.pois?.byType.powerspot ?? 0} power spots), ${meta.pois?.campsite ?? 0} Campsite.`,
        );
        say(
          `Raid route ${meta.shapes?.raidRoutePoints ?? 0} points, ` +
            `hotspot ${meta.shapes?.hotspotPoints ?? 0} points.`,
        );
        for (const w of meta.warnings ?? []) say(`Warning: ${w}`);

        setPhase('media');
        setTotal(meta.media?.rows ?? 0);
        say(`Copying ${meta.media?.rows ?? 0} photos into R2…`);

        let pass = 0;
        for (;;) {
          if (++pass > MAX_PASSES) throw new Error('Too many passes; stopping.');

          const step = await post<MediaResult>(`/api/admin/import-media?limit=${MEDIA_BATCH}`);
          if (step.error) throw new Error(step.error);

          const doneSoFar = (step.alreadyPresent ?? 0) + (step.uploaded ?? 0);
          setUploaded(doneSoFar);
          setTotal(step.total ?? 0);
          say(`Pass ${pass}: ${doneSoFar} of ${step.total ?? 0} photos in place.`);

          for (const f of step.failed ?? []) say(`Failed: ${f.key} — ${f.reason}`);

          // Guard against a pass that makes no progress, so a permanently
          // failing photo cannot spin here forever.
          if (step.done || (step.remaining ?? 0) === 0) break;
          if ((step.uploaded ?? 0) === 0) {
            throw new Error(`Stalled with ${step.remaining} photos remaining.`);
          }
        }

        say('Done. The map is live.');
        setPhase('done');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        say(`Stopped: ${message}`);
        setPhase('error');
      }
    },
    [say],
  );

  const busy = phase === 'metadata' || phase === 'media';
  const hasData = poiCount > 0;
  const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0;

  return (
    <section className="import-panel">
      <div className="import-head">
        <div>
          <h2>Legacy data import</h2>
          <p>
            Pulls every PokéStop, Gym, Power Spot, photo, the raid route and the hotspot from{' '}
            <code>pokemontxk.com</code> into this site. Safe to re-run — it upserts rather than
            duplicating, and skips photos already stored.
          </p>
        </div>
        <div className="import-state">
          <span>
            <strong>{poiCount}</strong> locations
          </span>
          <span>
            <strong>{mediaCount}</strong> photos
          </span>
        </div>
      </div>

      {!hasData && phase === 'idle' && (
        <p className="import-callout">
          This site has no map data yet. Run the import to bring across all 104 locations and 72
          photos.
        </p>
      )}

      {phase === 'media' && (
        <div className="import-progress">
          <div className="import-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <p>
            {uploaded} of {total} photos ({pct}%)
          </p>
        </div>
      )}

      {needsForce && (
        <div className="import-warn" role="alert">
          <p>
            There is already map data here. Re-importing clears the imported locations, photo
            records, map shapes and meetups first, then rebuilds them from the live site.
          </p>
          <p>
            <strong>Anything added or edited in the admin console will be lost.</strong>
          </p>
          <button type="button" className="btn btn--danger" onClick={() => void run(true)}>
            Clear and re-import anyway
          </button>
        </div>
      )}

      {error && (
        <p className="import-error" role="alert">
          {error}
        </p>
      )}

      {phase === 'done' && summary && (
        <p className="import-done">
          Imported {summary.pois?.total} locations and {summary.media?.rows} photos.{' '}
          {summary.media?.withCredit} carry a photographer credit.{' '}
          <a href="/map">Open the map →</a>
        </p>
      )}

      <div className="import-actions">
        <button
          type="button"
          className="btn"
          onClick={() => void run(false)}
          disabled={busy}
          aria-busy={busy}
        >
          {phase === 'metadata'
            ? 'Reading source…'
            : phase === 'media'
              ? 'Copying photos…'
              : hasData
                ? 'Re-run import'
                : 'Import from pokemontxk.com'}
        </button>
        {phase === 'done' && (
          <a className="btn btn--ghost" href="/admin/map">
            Open the map editor
          </a>
        )}
      </div>

      {log.length > 0 && (
        <ol className="import-log" aria-live="polite" aria-label="Import progress">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      )}
    </section>
  );
}
