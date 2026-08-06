import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MapPoi } from '~/lib/db/map';
import type { SessionUser } from '~/lib/auth/types';
import './QuickActions.css';

/**
 * The one-handed surface: designed to be used standing in a park, holding a
 * phone, with Pokémon GO open in the other app. Everything actionable sits in
 * the bottom third where a thumb reaches, and every target is at least 48px.
 */

type Kind = 'raid' | 'gym_takedown' | 'meetup_here' | 'remote_invites' | 'trade' | 'help';

interface ActionDef {
  kind: Kind;
  emoji: string;
  label: string;
  hint: string;
  /** Which POIs make sense for this action; null means "anywhere". */
  poiTypes: MapPoi['type'][] | null;
  needsBoss?: boolean;
  needsCount?: boolean;
}

const ACTIONS: ActionDef[] = [
  { kind: 'raid', emoji: '🔥', label: 'Raid', hint: 'Starting a raid, need people', poiTypes: ['gym'], needsBoss: true },
  { kind: 'remote_invites', emoji: '📣', label: 'Invites', hint: 'Spare remote invites', poiTypes: ['gym'], needsBoss: true, needsCount: true },
  { kind: 'gym_takedown', emoji: '⚔️', label: 'Takedown', hint: 'Taking a gym, want backup', poiTypes: ['gym'] },
  { kind: 'meetup_here', emoji: '👋', label: "I'm here", hint: 'Say where you are', poiTypes: null },
  { kind: 'trade', emoji: '🤝', label: 'Trade', hint: 'Looking to trade', poiTypes: null },
  { kind: 'help', emoji: '🙋', label: 'Need a hand', hint: 'Anything else', poiTypes: null },
];

/** Mirrors the payload of GET /api/flares — see src/lib/db/flares.ts. */
interface Flare {
  id: number;
  kind: Kind;
  boss: string | null;
  tier: string | null;
  needed: number | null;
  note: string | null;
  expiresAt: string;
  poi: { id: number; name: string; type: string } | null;
  /** `name` is the trainer name where we have one — the handle people know. */
  author: { id: number; name: string; team: string | null } | null;
  rsvps: { coming: number; here: number; done: number };
}

interface RaidBoss {
  name: string;
  tier: string;
}

function distanceMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(rad(a[0])) * Math.cos(rad(b[0]));
  return 2 * R * Math.asin(Math.sqrt(h));
}

const fmtDistance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

function minutesLeft(iso: string): number {
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

export default function QuickActions({ user }: { user: SessionUser | null }) {
  const [pois, setPois] = useState<MapPoi[]>([]);
  const [flares, setFlares] = useState<Flare[]>([]);
  const [mine, setMine] = useState<Record<string, string>>({});
  const [bosses, setBosses] = useState<RaidBoss[]>([]);
  const [here, setHere] = useState<[number, number] | null>(null);
  const [gpsState, setGpsState] = useState<'idle' | 'locating' | 'ok' | 'denied'>('idle');

  const [action, setAction] = useState<ActionDef | null>(null);
  const [poiId, setPoiId] = useState<number | null>(null);
  const [boss, setBoss] = useState('');
  const [needed, setNeeded] = useState(1);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const say = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'ok' ? 2800 : 6000);
  }, []);

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  const loadFlares = useCallback(async () => {
    try {
      const data = await api<{ flares: Flare[]; mine: Record<string, string> }>('/api/flares');
      setFlares(data.flares ?? []);
      setMine(data.mine ?? {});
    } catch {
      /* The board is a nicety here; the actions still work. */
    }
  }, []);

  useEffect(() => {
    fetch('/api/map.json')
      .then((r) => r.json() as Promise<{ pois?: MapPoi[] }>)
      .then((d) => setPois(d.pois ?? []))
      .catch(() => setPois([]));

    fetch('/api/game/raids.json')
      .then((r) => r.json() as Promise<{ data?: { name: string; tier: string }[] }>)
      .then((d) => setBosses((d.data ?? []).map((b) => ({ name: b.name, tier: b.tier }))))
      .catch(() => setBosses([]));

    void loadFlares();
    const id = window.setInterval(loadFlares, 20000);
    return () => window.clearInterval(id);
  }, [loadFlares]);

  // Ask for location on mount: every action is "what is near me", and a prompt
  // the moment they open it is less disruptive than one mid-flow.
  useEffect(() => {
    if (!navigator.geolocation) return;
    setGpsState('locating');
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setHere([pos.coords.latitude, pos.coords.longitude]);
        setGpsState('ok');
      },
      () => setGpsState('denied'),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  /** POIs valid for the open action, nearest first when we know where we are. */
  const candidates = useMemo(() => {
    if (!action) return [];
    const allowed = action.poiTypes;
    const list = pois.filter((p) => !allowed || allowed.includes(p.type));
    if (!here) return list.slice(0, 40);
    return list
      .map((p) => ({ poi: p, d: distanceMeters(here, [p.lat, p.lng]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 40);
  }, [action, pois, here]);

  const openAction = (def: ActionDef) => {
    setAction(def);
    setBoss('');
    setNeeded(1);
    setNote('');
    // Preselect the nearest valid location — usually the right answer, and it
    // turns a three-tap flow into one.
    const first = (() => {
      const allowed = def.poiTypes;
      const list = pois.filter((p) => !allowed || allowed.includes(p.type));
      if (!here || list.length === 0) return null;
      return list.reduce((best, p) =>
        distanceMeters(here, [p.lat, p.lng]) < distanceMeters(here, [best.lat, best.lng]) ? p : best,
      );
    })();
    setPoiId(first?.id ?? null);
  };

  const fire = async () => {
    if (!action) return;
    setSending(true);
    try {
      await api('/api/flares', {
        method: 'POST',
        body: JSON.stringify({
          kind: action.kind,
          poiId,
          boss: action.needsBoss && boss ? boss : null,
          needed: action.needsCount ? needed : null,
          note: note || null,
        }),
      });
      setAction(null);
      await loadFlares();
      say('ok', 'Flare sent. The community can see it now.');
      if ('vibrate' in navigator) navigator.vibrate?.(60);
    } catch (err) {
      say('err', err instanceof Error ? err.message : 'Could not send');
    } finally {
      setSending(false);
    }
  };

  const rsvp = async (flare: Flare, state: 'coming' | 'here' | 'out') => {
    try {
      await api(`/api/flares/${flare.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'rsvp', state }),
      });
      await loadFlares();
    } catch (err) {
      say('err', err instanceof Error ? err.message : 'Could not update');
    }
  };

  const signedIn = Boolean(user);
  const canPost = user && user.role !== 'guest';

  return (
    <div className="go">
      <header className="go-head">
        <div>
          <h1>Quick actions</h1>
          <p className="go-sub">
            {gpsState === 'ok' && here
              ? 'Located — nearest gyms first'
              : gpsState === 'locating'
                ? 'Finding you…'
                : gpsState === 'denied'
                  ? 'Location off — pick manually'
                  : 'Location unavailable'}
          </p>
        </div>
        {user ? (
          <span className="go-user">{user.displayName}</span>
        ) : (
          <a className="go-signin" href="/auth/login?next=%2Fgo">
            Sign in
          </a>
        )}
      </header>

      <section className="go-board" aria-label="Active flares">
        {flares.length === 0 ? (
          <p className="go-empty">
            Nothing active right now. Fire one below when you are at a gym and want company.
          </p>
        ) : (
          <ul>
            {flares.map((flare) => {
              const def = ACTIONS.find((a) => a.kind === flare.kind);
              const state = mine[String(flare.id)];
              // "coming" and "here" both mean a body is on its way or present.
              const going = (flare.rsvps?.coming ?? 0) + (flare.rsvps?.here ?? 0);
              return (
                <li key={flare.id} className="go-flare">
                  <span className="go-flare-emoji" aria-hidden="true">
                    {def?.emoji ?? '📍'}
                  </span>
                  <div className="go-flare-body">
                    <strong>
                      {flare.boss ? flare.boss : (def?.label ?? 'Flare')}
                      {flare.needed ? ` · needs ${flare.needed}` : ''}
                    </strong>
                    <span>
                      {flare.poi?.name ?? 'Somewhere in the park'} · {minutesLeft(flare.expiresAt)}m
                      left
                      {flare.author ? ` · ${flare.author.name}` : ''}
                      {going > 0 ? ` · ${going} going` : ''}
                    </span>
                    {flare.note && <span className="go-flare-note">{flare.note}</span>}
                  </div>
                  {canPost && (
                    <button
                      type="button"
                      className={`go-join${state ? ' is-in' : ''}`}
                      onClick={() => void rsvp(flare, state ? 'out' : 'coming')}
                      aria-pressed={Boolean(state)}
                    >
                      {state ? 'In' : 'Join'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {!canPost && (
        <p className="go-gate">
          {signedIn
            ? 'Your account is not a community member yet — ask an ambassador on Discord.'
            : 'Sign in with Discord to fire a flare.'}
        </p>
      )}

      <nav className="go-actions" aria-label="Quick actions">
        {ACTIONS.map((def) => (
          <button
            key={def.kind}
            type="button"
            className="go-action"
            disabled={!canPost}
            onClick={() => openAction(def)}
          >
            <span className="go-action-emoji" aria-hidden="true">
              {def.emoji}
            </span>
            <span className="go-action-label">{def.label}</span>
          </button>
        ))}
      </nav>

      {action && (
        <div className="go-sheet-backdrop" onClick={() => setAction(null)}>
          <section
            className="go-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={action.label}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <span aria-hidden="true">{action.emoji}</span>
              <div>
                <h2>{action.label}</h2>
                <p>{action.hint}</p>
              </div>
              <button type="button" className="go-close" onClick={() => setAction(null)} aria-label="Close">
                ×
              </button>
            </header>

            <label className="go-field">
              <span>Where</span>
              <select value={poiId ?? ''} onChange={(e) => setPoiId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">— not at a specific spot —</option>
                {candidates.map((c) => {
                  const poi = 'poi' in c ? c.poi : (c as unknown as MapPoi);
                  const d = 'd' in c ? ` — ${fmtDistance(c.d)}` : '';
                  return (
                    <option key={poi.id} value={poi.id}>
                      {poi.name}
                      {d}
                    </option>
                  );
                })}
              </select>
            </label>

            {action.needsBoss && (
              <label className="go-field">
                <span>Boss</span>
                <input
                  list="go-bosses"
                  value={boss}
                  onChange={(e) => setBoss(e.target.value)}
                  placeholder={bosses[0]?.name ?? 'e.g. Mewtwo'}
                  maxLength={80}
                />
                <datalist id="go-bosses">
                  {bosses.map((b) => (
                    <option key={`${b.tier}-${b.name}`} value={b.name}>
                      {b.tier}
                    </option>
                  ))}
                </datalist>
              </label>
            )}

            {action.needsCount && (
              <label className="go-field">
                <span>How many more do you need?</span>
                <div className="go-stepper">
                  <button type="button" onClick={() => setNeeded((n) => Math.max(1, n - 1))} aria-label="One fewer">
                    −
                  </button>
                  <output>{needed}</output>
                  <button type="button" onClick={() => setNeeded((n) => Math.min(20, n + 1))} aria-label="One more">
                    +
                  </button>
                </div>
              </label>
            )}

            <label className="go-field">
              <span>Note (optional)</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Starting in 5, parking lot side"
                maxLength={280}
              />
            </label>

            <button type="button" className="go-fire" onClick={() => void fire()} disabled={sending}>
              {sending ? 'Sending…' : `Send ${action.label.toLowerCase()} flare`}
            </button>
          </section>
        </div>
      )}

      {toast && (
        <p className={`go-toast go-toast--${toast.kind}`} role="status">
          {toast.text}
        </p>
      )}
    </div>
  );
}
