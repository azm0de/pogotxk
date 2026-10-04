import { useCallback, useState } from 'react';
import { api, ApiError, SignedOutError } from '~/lib/client-api';
import { SignedOutText } from './admin-ui';
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

/**
 * The one-time import from the old site.
 *
 * It runs once. On a database that already holds locations the importer
 * answers 409 and changes nothing, and there is no override: the "Clear and
 * re-import anyway" button, which wiped every admin edit, is gone (admin audit,
 * 2026-10, B-12 — Justin's decision). A re-import from scratch is a developer
 * task. What stays safe to repeat is the photo copy, which skips anything
 * already stored, so a populated site is offered only that.
 */
export default function ImportPanel({ poiCount, mediaCount }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  /** The importer answered 409: there is data here already. */
  const [refused, setRefused] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<LegacyResult | null>(null);
  const [photosOnly, setPhotosOnly] = useState(false);

  const say = useCallback((line: string) => setLog((l) => [...l, line]), []);

  /** The resumable photo copy. Shared by a first import and a top-up. */
  const copyPhotos = useCallback(async () => {
    setPhase('media');
    let pass = 0;
    for (;;) {
      if (++pass > MAX_PASSES) throw new Error('Too many passes; stopping.');

      const step = await api<MediaResult>(`/api/admin/import-media?limit=${MEDIA_BATCH}`, {
        method: 'POST',
      });
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
  }, [say]);

  const reset = () => {
    setError(null);
    setSignedOut(false);
    setRefused(null);
    setLog([]);
    setUploaded(0);
    setTotal(0);
    setSummary(null);
  };

  const stopped = (err: unknown) => {
    if (err instanceof SignedOutError) {
      setSignedOut(true);
      say('Stopped: signed out.');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      say(`Stopped: ${message}`);
    }
    setPhase('error');
  };

  const runImport = useCallback(async () => {
    reset();
    setPhotosOnly(false);
    setPhase('metadata');
    try {
      say('Reading the old site’s locations, map shapes and meetups from pokemontxk.com…');
      let meta: LegacyResult;
      try {
        meta = await api<LegacyResult>('/api/admin/import-legacy', { method: 'POST' });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Not a failure: the guard doing its job. Nothing was changed.
          const why = err.body.error ?? 'The database already contains locations.';
          setRefused(why);
          say(`${why} Nothing was changed.`);
          setPhase('idle');
          return;
        }
        throw err;
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

      setTotal(meta.media?.rows ?? 0);
      say(`Copying ${meta.media?.rows ?? 0} photos into R2…`);
      await copyPhotos();

      say('Done. The map is live.');
      setPhase('done');
    } catch (err) {
      stopped(err);
    }
    // `reset` and `stopped` only call stable setters and `say`.
  }, [say, copyPhotos]);

  const runPhotos = useCallback(async () => {
    reset();
    setPhotosOnly(true);
    try {
      say('Checking every legacy photo is stored, and copying any that are missing…');
      await copyPhotos();
      say('Done. Every legacy photo is in place.');
      setPhase('done');
    } catch (err) {
      stopped(err);
    }
  }, [say, copyPhotos]);

  const busy = phase === 'metadata' || phase === 'media';
  const hasData = poiCount > 0;
  const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0;

  return (
    <section className="import-panel panel">
      <div className="import-head">
        <div>
          <h2>Legacy data import</h2>
          {hasData ? (
            <p>
              The map was imported from <code className="admin-code">pokemontxk.com</code>. The
              import runs once: on a site that already has locations it stops without changing
              anything, so edits made here are never overwritten. Copying photos is safe to repeat
              — it skips any already stored.
            </p>
          ) : (
            <p>
              Pulls every PokéStop, Gym, Power Spot, photo, the raid route and the hotspot from{' '}
              <code className="admin-code">pokemontxk.com</code> into this site. It runs once, on
              an empty site.
            </p>
          )}
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

      {!hasData && phase === 'idle' && !refused && (
        <p className="import-callout">
          This site has no map data yet. Run the import to bring across the old site's locations
          and photos.
        </p>
      )}

      {phase === 'media' && (
        <div className="import-progress">
          <div
            className="import-bar"
            role="progressbar"
            aria-label="Photos copied"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            {/* A transform, not a width: see the note in ImportPanel.css. */}
            <span style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          <p>
            {uploaded} of {total} photos ({pct}%)
          </p>
        </div>
      )}

      {refused && (
        <p className="import-note" role="status">
          {refused} Nothing was changed. Starting over from the old site is a developer task: the
          rows are cleared in the database first.
        </p>
      )}

      {(error || signedOut) && (
        <p className="import-error" role="alert">
          <strong>Error: </strong>
          {signedOut ? <SignedOutText /> : error}
        </p>
      )}

      {phase === 'done' && (
        <p className="import-done">
          <span>
            {summary && !photosOnly ? (
              <>
                Imported {summary.pois?.total} locations and {summary.media?.rows} photos.{' '}
                {summary.media?.withCredit} carry a photographer credit.
              </>
            ) : (
              <>
                {uploaded} of {total} photos in place.
              </>
            )}
          </span>
          <a className="btn btn--outline btn--sm btn--arrow" href="/map">
            Open the map
          </a>
        </p>
      )}

      <div className="import-actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void (hasData ? runPhotos() : runImport())}
          disabled={busy}
          aria-busy={busy}
        >
          {phase === 'metadata'
            ? 'Reading source…'
            : phase === 'media'
              ? 'Copying photos…'
              : hasData
                ? 'Copy any missing photos'
                : 'Import from pokemontxk.com'}
        </button>
        {phase === 'done' && (
          <a className="btn btn--outline btn--arrow" href="/admin/map">
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
