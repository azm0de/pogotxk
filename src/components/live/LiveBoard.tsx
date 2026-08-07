import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  FLARE_KIND_LABEL,
  FLARE_KINDS,
  FLARE_TTL_MINUTES,
  type Flare,
  type FlareKind,
  type FlareRsvpState,
} from '~/lib/db/flares';
import './LiveBoard.css';

/**
 * The live board.
 *
 * The page server-renders the current flares and hands them in as props, so the
 * first paint is correct and there is no snapshot-versus-socket race: the
 * socket only ever carries deltas on top of a list the client already has.
 *
 * Three things this has to survive, because a phone at a park will do all
 * three: a socket that drops when the screen locks, a Durable Object binding
 * that is not there at all, and a device clock that is minutes off.
 */

/** Reconnect backoff: 1s, 2s, 4s … capped, with jitter so a mass reconnect
 *  after a deploy does not arrive as one thundering herd. */
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/** Failures before we stop waiting on the socket and just poll. */
const POLL_AFTER_ATTEMPTS = 3;
const POLL_MS = 20_000;
/**
 * How long a socket has to stay up before we call it a real connection and
 * forgive the earlier failures. Resetting the backoff the instant `open` fires
 * would mean a socket that is accepted and then dropped straight away —
 * an overloaded object, a proxy that allows the upgrade and kills it, a deploy
 * cycling the DO — never backs off and never falls through to polling: it just
 * reconnects (and re-fetches the board) roughly once a second, forever.
 */
const STABLE_CONNECTION_MS = 10_000;
/** Well inside the 100s edge idle timeout, and free while the object sleeps. */
const HEARTBEAT_MS = 30_000;
/**
 * Must match `HEARTBEAT` in src/do/LiveBoard.ts, where it is registered as the
 * object's WebSocket auto-response. Copied rather than imported: that module
 * pulls in `cloudflare:workers`, which has no business in a browser bundle.
 */
const HEARTBEAT = 'ping';
/** Countdown granularity. Flares are shown in minutes; 5s is plenty. */
const TICK_MS = 5000;

type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'polling';

interface PoiOption {
  id: number;
  name: string;
  type: string;
}

interface Snapshot {
  now: string;
  flares: Flare[];
  mine: Record<number, FlareRsvpState>;
}

export interface LiveBoardProps {
  initialFlares: Flare[];
  /** The server's clock at render time — the origin for the countdowns. */
  initialNow: string;
  initialMine: Record<number, FlareRsvpState>;
  /** `member` or better: may raise flares and RSVP. */
  canPost: boolean;
  signedIn: boolean;
  currentUserId: number | null;
  canModerate: boolean;
}

interface FormState {
  kind: FlareKind;
  poiId: number | null;
  boss: string;
  tier: string;
  needed: string;
  note: string;
  minutes: string;
}

const EMPTY_FORM: FormState = {
  kind: 'raid',
  poiId: null,
  boss: '',
  tier: '',
  needed: '',
  note: '',
  minutes: '',
};

const RSVP_LABEL: Record<FlareRsvpState, string> = {
  coming: 'On my way',
  here: "I'm here",
  done: 'Done',
};

function socketUrl(): string {
  const url = new URL('/api/flares/socket', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function minutesBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / 60_000);
}

function timeLeft(expiresAt: string, nowMs: number): string {
  const mins = minutesBetween(nowMs, Date.parse(expiresAt));
  if (mins <= 0) return 'about to expire';
  if (mins < 60) return `${mins} min left`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours} h ${rest} min left` : `${hours} h left`;
}

function posted(createdAt: string, nowMs: number): string {
  const mins = minutesBetween(Date.parse(createdAt), nowMs);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} h ago`;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (${res.status})`;
}

export default function LiveBoard({
  initialFlares,
  initialNow,
  initialMine,
  canPost,
  signedIn,
  currentUserId,
  canModerate,
}: LiveBoardProps) {
  const [flares, setFlares] = useState<Flare[]>(initialFlares);
  const [mine, setMine] = useState<Record<number, FlareRsvpState>>(initialMine);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [watching, setWatching] = useState<number | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<number | 'new' | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pois, setPois] = useState<PoiOption[] | null>(null);

  /**
   * How far this device's clock is behind the server's. Seeded from the
   * server-rendered timestamp and refreshed from every snapshot, so a phone
   * that is five minutes fast does not hide flares everyone else can still see.
   */
  const skewRef = useRef(0);
  const [nowMs, setNowMs] = useState(() => Date.parse(initialNow));
  const poisRequested = useRef(false);

  /**
   * One timer, not one per toast: without this an earlier toast's timeout
   * fires while a later toast is on screen and clears it early — an error
   * raised 2s after a success would vanish almost immediately.
   */
  const toastTimer = useRef(0);
  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'ok' ? 2600 : 6000);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const upsert = useCallback((flare: Flare) => {
    setFlares((prev) => {
      const next = prev.filter((f) => f.id !== flare.id);
      next.push(flare);
      return next;
    });
  }, []);

  /** Full snapshot. Also the polling fallback, and the reconciliation step
   *  after a reconnect — anything missed while the socket was down lands here. */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/flares', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as Snapshot;
      skewRef.current = Date.parse(body.now) - Date.now();
      setNowMs(Date.now() + skewRef.current);
      setFlares(body.flares);
      setMine(body.mine ?? {});
    } catch {
      // Silent: the connection indicator already says the board is degraded,
      // and a failed background poll is not worth a toast.
    }
  }, []);

  const applyEvent = useCallback(
    (raw: unknown) => {
      if (typeof raw !== 'string') return;
      let event: {
        type?: string;
        flare?: Flare;
        id?: number;
        connections?: number;
        serverTime?: string;
      };
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        return;
      }

      switch (event.type) {
        case 'welcome':
          if (event.serverTime) {
            skewRef.current = Date.parse(event.serverTime) - Date.now();
            setNowMs(Date.now() + skewRef.current);
          }
          if (typeof event.connections === 'number') setWatching(event.connections);
          break;
        case 'presence':
          if (typeof event.connections === 'number') setWatching(event.connections);
          break;
        case 'flare':
        case 'update':
          if (event.flare) upsert(event.flare);
          break;
        case 'closed':
          if (typeof event.id === 'number') {
            const id = event.id;
            setFlares((prev) => prev.filter((f) => f.id !== id));
          }
          break;
        default:
          break;
      }
    },
    [upsert],
  );

  // --- the countdown clock ------------------------------------------------
  // Seeded from `initialNow` so the first client render matches the server's
  // markup exactly; only after mount does it start tracking the real clock.
  useEffect(() => {
    skewRef.current = Date.parse(initialNow) - Date.now();
    const timer = window.setInterval(() => setNowMs(Date.now() + skewRef.current), TICK_MS);
    return () => window.clearInterval(timer);
  }, [initialNow]);

  // --- the connection -----------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let attempts = 0;
    /** When the current socket opened, or 0 while there is no open socket. */
    let openedAt = 0;
    let retryTimer = 0;
    let heartbeatTimer = 0;
    let pollTimer = 0;

    const stopPolling = () => {
      if (!pollTimer) return;
      window.clearInterval(pollTimer);
      pollTimer = 0;
    };

    const startPolling = () => {
      if (pollTimer || disposed) return;
      void refresh();
      pollTimer = window.setInterval(() => void refresh(), POLL_MS);
    };

    const stopHeartbeat = () => {
      if (!heartbeatTimer) return;
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = 0;
    };

    const scheduleReconnect = () => {
      if (disposed || retryTimer) return;
      attempts += 1;

      // Once the socket has failed a few times, assume it is not coming back
      // soon — a corporate proxy, a captive portal, or no LIVE binding — and
      // fall back to polling. The socket keeps retrying underneath; if it
      // succeeds the polling stops again.
      if (attempts >= POLL_AFTER_ATTEMPTS) {
        setStatus('polling');
        startPolling();
      } else {
        setStatus('reconnecting');
      }

      const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1));
      const delay = ceiling / 2 + Math.random() * (ceiling / 2);
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed || socket) return;

      if (typeof WebSocket === 'undefined') {
        setStatus('polling');
        startPolling();
        return;
      }

      if (attempts === 0) setStatus('connecting');

      let ws: WebSocket;
      try {
        ws = new WebSocket(socketUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      socket = ws;

      ws.addEventListener('open', () => {
        if (disposed) {
          ws.close();
          return;
        }
        openedAt = Date.now();
        setStatus('live');
        stopPolling();
        // Catch up on anything that happened while we were away.
        void refresh();
        heartbeatTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(HEARTBEAT);
        }, HEARTBEAT_MS);
      });

      ws.addEventListener('message', (event) => applyEvent(event.data));

      ws.addEventListener('close', () => {
        stopHeartbeat();
        // Only a connection that actually held counts as success. A socket that
        // opens and dies immediately leaves `attempts` where it was, so the
        // backoff keeps growing and the board still falls through to polling.
        if (openedAt && Date.now() - openedAt >= STABLE_CONNECTION_MS) attempts = 0;
        openedAt = 0;
        socket = null;
        setWatching(null);
        scheduleReconnect();
      });

      // An error is always followed by a close, which is where the retry lives.
      ws.addEventListener('error', () => stopHeartbeat());
    };

    // Phones suspend sockets when the screen locks. Coming back to the tab is
    // the moment the user most wants a current board, so retry immediately
    // rather than waiting out the backoff.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || disposed) return;
      void refresh();
      if (!socket) {
        if (retryTimer) {
          window.clearTimeout(retryTimer);
          retryTimer = 0;
        }
        connect();
      }
    };

    connect();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (retryTimer) window.clearTimeout(retryTimer);
      stopHeartbeat();
      stopPolling();
      socket?.close();
      socket = null;
    };
  }, [applyEvent, refresh]);

  // --- actions ------------------------------------------------------------

  const loadPois = useCallback(async () => {
    if (poisRequested.current) return;
    poisRequested.current = true;
    try {
      // The map payload is the only public list of POIs and it is already
      // edge-cached, so this costs nothing on a warm cache — and nothing at all
      // for the majority of visitors, who never open the form.
      const res = await fetch('/api/map.json');
      if (!res.ok) throw new Error('unavailable');
      const data = (await res.json()) as { pois: PoiOption[] };
      setPois(
        data.pois
          .map((p) => ({ id: p.id, name: p.name, type: p.type }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    } catch {
      setPois([]);
    }
  }, []);

  const openForm = useCallback(() => {
    setFormOpen(true);
    void loadPois();
  }, [loadPois]);

  const rsvp = async (flare: Flare, state: FlareRsvpState) => {
    const next = mine[flare.id] === state ? 'out' : state;
    setBusyId(flare.id);
    try {
      const res = await fetch(`/api/flares/${flare.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rsvp', state: next }),
      });

      if (res.status === 410) {
        setFlares((prev) => prev.filter((f) => f.id !== flare.id));
        notify('err', 'That flare just expired.');
        return;
      }
      if (!res.ok) throw new Error(await readError(res));

      const body = (await res.json()) as { flare: Flare; mine: FlareRsvpState | null };
      upsert(body.flare);
      setMine((prev) => {
        const copy = { ...prev };
        if (body.mine) copy[flare.id] = body.mine;
        else delete copy[flare.id];
        return copy;
      });
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not send that');
    } finally {
      setBusyId(null);
    }
  };

  const close = async (flare: Flare) => {
    setBusyId(flare.id);
    try {
      const res = await fetch(`/api/flares/${flare.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'close' }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setFlares((prev) => prev.filter((f) => f.id !== flare.id));
      notify('ok', 'Flare closed');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not close it');
    } finally {
      setBusyId(null);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusyId('new');
    try {
      const res = await fetch('/api/flares', {
        method: 'POST',
        // Astro rejects cross-site POSTs without a JSON content type.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: form.kind,
          poiId: form.poiId,
          boss: form.boss.trim() || null,
          tier: form.tier.trim() || null,
          needed: form.needed ? Number(form.needed) : null,
          note: form.note.trim() || null,
          minutes: form.minutes ? Number(form.minutes) : undefined,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));

      const body = (await res.json()) as { flare: Flare };
      // Insert straight away rather than waiting for our own broadcast to come
      // back round — the poster should see their flare the instant it lands.
      upsert(body.flare);
      setForm(EMPTY_FORM);
      setFormOpen(false);
      notify('ok', 'Flare is up');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not post that');
    } finally {
      setBusyId(null);
    }
  };

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // --- derived ------------------------------------------------------------

  // Expiry is enforced here as well as in SQL: a flare posted for 45 minutes
  // leaves the board on the minute for everyone watching, with no request and
  // no cron.
  const visible = useMemo(
    () =>
      flares
        .filter((f) => !f.closedAt && Date.parse(f.expiresAt) > nowMs)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [flares, nowMs],
  );

  /**
   * Screen reader announcement for the board itself.
   *
   * A summary, not the cards. Announcing every arriving flare on a busy evening
   * would talk over whatever the user is actually doing — worse than silence.
   * A count tells them something changed and invites them to go look, which is
   * the useful signal. Only fires when the number actually moves.
   */
  const [announcement, setAnnouncement] = useState('');
  const lastCount = useRef<number | null>(null);

  useEffect(() => {
    const count = visible.length;
    if (lastCount.current === count) return;
    const first = lastCount.current === null;
    lastCount.current = count;
    // Say nothing on first paint; the heading already describes the page.
    if (first) return;
    setAnnouncement(
      count === 0
        ? 'No flares active.'
        : `${count} ${count === 1 ? 'flare' : 'flares'} active.`,
    );
  }, [visible.length]);

  const statusText =
    status === 'live'
      ? watching !== null && watching > 1
        ? `Live · ${watching} watching`
        : 'Live'
      : status === 'connecting'
        ? 'Connecting…'
        : status === 'reconnecting'
          ? 'Reconnecting…'
          : 'Live updates unavailable — refreshing every 20 seconds';

  return (
    <div className="live">
      <header className="live-head">
        <div>
          <h1>Live board</h1>
          <p>
            Raids, takedowns and trades happening right now. Flares expire on their own — raids
            after {FLARE_TTL_MINUTES.raid} minutes, trades after {FLARE_TTL_MINUTES.trade / 60}{' '}
            hours.
          </p>
        </div>

        <p className={`live-status live-status--${status}`} role="status" aria-live="polite">
          <span className="live-dot" aria-hidden="true" />
          {statusText}
        </p>
      </header>

      {toast && (
        <p className={`live-toast live-toast--${toast.kind}`} role="status">
          {toast.text}
        </p>
      )}

      {canPost ? (
        <section className="live-compose">
          {formOpen ? (
            <form onSubmit={submit}>
              <h2>Raise a flare</h2>

              <div className="kind-row" role="group" aria-label="What is happening">
                {FLARE_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`chip chip--${kind}`}
                    aria-pressed={form.kind === kind}
                    onClick={() => setField('kind', kind)}
                  >
                    {FLARE_KIND_LABEL[kind]}
                  </button>
                ))}
              </div>

              <div className="form-grid">
                <label>
                  <span>Where</span>
                  <select
                    value={form.poiId ?? ''}
                    onChange={(e) =>
                      setField('poiId', e.target.value ? Number(e.target.value) : null)
                    }
                  >
                    <option value="">— anywhere —</option>
                    {(pois ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Expires in</span>
                  <select
                    value={form.minutes}
                    onChange={(e) => setField('minutes', e.target.value)}
                  >
                    <option value="">Default ({FLARE_TTL_MINUTES[form.kind]} min)</option>
                    <option value="15">15 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="60">1 hour</option>
                    <option value="120">2 hours</option>
                  </select>
                </label>
              </div>

              {form.kind === 'raid' && (
                <div className="form-grid">
                  <label>
                    <span>Boss</span>
                    <input
                      value={form.boss}
                      onChange={(e) => setField('boss', e.target.value)}
                      placeholder="e.g. Azelf"
                      maxLength={80}
                    />
                  </label>
                  <label>
                    <span>Tier</span>
                    <input
                      value={form.tier}
                      onChange={(e) => setField('tier', e.target.value)}
                      placeholder="e.g. 5"
                      maxLength={24}
                    />
                  </label>
                </div>
              )}

              {form.kind === 'remote_invites' && (
                <label>
                  <span>Spaces still open</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={form.needed}
                    onChange={(e) => setField('needed', e.target.value)}
                  />
                </label>
              )}

              <label>
                <span>Note</span>
                <input
                  value={form.note}
                  onChange={(e) => setField('note', e.target.value)}
                  placeholder="Starting in five, need three more"
                  maxLength={280}
                />
              </label>

              <div className="form-actions">
                <button type="submit" className="btn" disabled={busyId === 'new'}>
                  {busyId === 'new' ? 'Posting…' : 'Send it up'}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setFormOpen(false)}
                  disabled={busyId === 'new'}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="btn btn--big" onClick={openForm}>
              + Raise a flare
            </button>
          )}
        </section>
      ) : (
        <p className="live-signin">
          {signedIn ? (
            <>
              Flares are for community members.{' '}
              <a href="https://discord.com/invite/2sYR5YdRpH" rel="noopener noreferrer">
                Join the Discord
              </a>{' '}
              and your account will be upgraded on your next sign-in.
            </>
          ) : (
            <>
              <a href="/auth/login?next=%2Flive">Sign in with Discord</a> to raise a flare or say
              you are on your way.
            </>
          )}
        </p>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {visible.length === 0 ? (
        <p className="live-empty empty-art-bg">
          Nothing burning right now. When someone starts a raid it will appear here without a
          refresh.
        </p>
      ) : (
        <ul className="flare-list">
          {visible.map((flare) => {
            const myState = mine[flare.id];
            const mineToClose = currentUserId !== null && flare.author?.id === currentUserId;
            return (
              <li key={flare.id} className={`flare flare--${flare.kind}`}>
                <div className="flare-head">
                  <span className={`flare-kind flare-kind--${flare.kind}`}>
                    {FLARE_KIND_LABEL[flare.kind]}
                  </span>
                  <span className="flare-left">{timeLeft(flare.expiresAt, nowMs)}</span>
                </div>

                <h3 className="flare-title">
                  {flare.kind === 'raid' && flare.boss
                    ? `${flare.boss}${flare.tier ? ` · Tier ${flare.tier}` : ''}`
                    : flare.kind === 'remote_invites' && flare.needed
                      ? `${flare.needed} space${flare.needed === 1 ? '' : 's'} open`
                      : FLARE_KIND_LABEL[flare.kind]}
                </h3>

                {flare.poi ? (
                  <p className="flare-where">
                    <a href={`/map?poi=${encodeURIComponent(flare.poi.slug)}`}>{flare.poi.name}</a>
                  </p>
                ) : (
                  <p className="flare-where flare-where--none">No location given</p>
                )}

                {flare.note && <p className="flare-note">{flare.note}</p>}

                <p className="flare-meta">
                  {flare.author ? (
                    <span className={`flare-author flare-author--${flare.author.team ?? 'none'}`}>
                      {flare.author.name}
                    </span>
                  ) : (
                    <span className="flare-author">Someone</span>
                  )}
                  <span> · {posted(flare.createdAt, nowMs)}</span>
                  {flare.rsvps.coming + flare.rsvps.here > 0 && (
                    <span>
                      {' '}
                      · {flare.rsvps.coming} coming
                      {flare.rsvps.here > 0 && `, ${flare.rsvps.here} there`}
                    </span>
                  )}
                </p>

                {canPost && (
                  <div className="flare-actions">
                    {(['coming', 'here'] as const).map((state) => (
                      <button
                        key={state}
                        type="button"
                        className="chip"
                        aria-pressed={myState === state}
                        disabled={busyId === flare.id}
                        onClick={() => void rsvp(flare, state)}
                      >
                        {RSVP_LABEL[state]}
                      </button>
                    ))}
                    {(mineToClose || canModerate) && (
                      <button
                        type="button"
                        className="chip chip--close"
                        disabled={busyId === flare.id}
                        onClick={() => void close(flare)}
                      >
                        Close
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
