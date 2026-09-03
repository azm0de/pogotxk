import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { Team } from '~/lib/auth/types';
import {
  FLARE_KIND_LABEL,
  FLARE_KINDS,
  FLARE_TTL_MINUTES,
  flareCarriesBoss,
  flareCarriesTier,
  mayAlterFlare,
  type Flare,
  type FlareKind,
  type FlareRsvpState,
} from '~/lib/db/flares';
import { FlareIcon } from '~/components/go/flareIcons';
import { proxiedImageUrl } from '~/lib/game-image';
import { slugify } from '~/lib/slug';
import { DEFAULT_TZ } from '~/lib/time';
import './LiveBoard.css';

/**
 * The live board — the kiosk's now-panel, written as a running log.
 *
 * Every other surface on this site is a sign bolted over the map. This one is
 * the notice the warden keeps updating: a timestamped list where the flares and
 * the board's own condition print themselves as lines, newest at the top. That
 * is why the connection state is not only a pill — when it changes it writes
 * itself into the log, so a reader scrolling the board can see *when* the
 * updates stopped rather than only that they are stopped now.
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
/**
 * How long a socket attempt gets before it counts as failed rather than still
 * connecting. A handshake that hangs — a captive portal or proxy that accepts
 * the TCP connection and never completes the upgrade — fires neither `open`
 * nor `close`/`error` on its own, so nothing above would ever notice: `status`
 * would sit on 'connecting' (which deliberately renders no pill) forever, and
 * the board would go stale with nothing telling the reader that. Forcing the
 * socket closed after this bound gives a hang the same fate as any other
 * failed attempt — `close` fires, `scheduleReconnect` runs, and eventually the
 * board falls through to polling like it would for a clean failure.
 */
const CONNECT_TIMEOUT_MS = 10_000;
/** Generous rather than tight — this is a phone on park wifi. */
const FETCH_TIMEOUT_MS = 12_000;
/** How many system lines the log keeps. Older ones are history nobody reads. */
const MAX_SYS_LINES = 6;

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

const TEAM_LABEL: Record<Team, string> = {
  valor: 'Valor',
  mystic: 'Mystic',
  instinct: 'Instinct',
};

/**
 * The board's clock, pinned to Texarkana rather than to the reader's device.
 *
 * Two reasons. It is the park's board, and every other date on this site is
 * already rendered in `DEFAULT_TZ` (meetups, posts, the calendar), so a flare
 * stamped in a visitor's own zone would be the one time on the site that did
 * not line up with the meetup listed beside it. And it is deterministic: the
 * server and the browser format the same instant to the same string, so the
 * hydrated markup matches and React has nothing to patch.
 */
const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: DEFAULT_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function stamp(atMs: number): string {
  return clockFmt.format(new Date(atMs));
}

/**
 * Loosens a boss name enough to match what someone typed against the feed.
 *
 * `boss` is free text — a human at a gym with one hand on their phone. The
 * project rule is that the name is matched against a public list, never read
 * from the game, and `slugify` already folds case, spacing, accents and
 * punctuation exactly the way that needs. Reused rather than reimplemented: it
 * is the same normalisation the tags and slugs use, and it is already tested.
 *
 * A miss is fine and expected — the card reads correctly without a sprite.
 */
const normaliseBossName = slugify;

/** Only the two fields the sprite lookup needs, not the whole raid shape. */
interface RaidFeedResponse {
  data?: { name: string; image: string }[];
}

/**
 * What each connection state prints into the log.
 *
 * `connecting` prints nothing: it is the state every single page load passes
 * through, so a line for it would be noise on a board that is working.
 */
const SYS_LINE: Record<ConnectionStatus, string | null> = {
  connecting: null,
  live: 'Live updates back on',
  reconnecting: 'Reconnecting…',
  polling: 'Live updates unavailable, refreshing every 20 seconds',
};

interface SysLine {
  id: number;
  at: number;
  text: string;
}

/** One row of the log: a flare, or something the board itself did. */
type LogEntry =
  | { kind: 'flare'; at: number; flare: Flare }
  | { kind: 'sys'; at: number; line: SysLine };

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
  const uid = useId();
  const [flares, setFlares] = useState<Flare[]>(initialFlares);
  const [mine, setMine] = useState<Record<number, FlareRsvpState>>(initialMine);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<number | 'new' | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pois, setPois] = useState<PoiOption[] | null>(null);

  /** The flare being corrected, and the values in the correction form. */
  const [editing, setEditing] = useState<Flare | null>(null);
  const [editBoss, setEditBoss] = useState('');
  const [editTier, setEditTier] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

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
      const res = await fetch('/api/flares', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
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
          break;
        /* `event.connections` is still sent and still ignored on purpose. The
           pill survives but the headcount does not — see `statusText` below —
           so nothing reads this. The server contract is left unchanged so the
           two sides never have to negotiate over a field the client simply
           declines to use. */
        case 'presence':
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

  /**
   * Boss name -> sprite, for putting a face on a raid flare.
   *
   * Resolved on the client rather than served with the flare, so that flares
   * arriving over the WebSocket get a sprite on exactly the same terms as ones
   * that came from the poll — enriching the API response would have covered
   * only half the paths into this list.
   *
   * A miss is fine and expected: `boss` is free text a human typed, and the
   * card already reads correctly without a picture.
   */
  const [bossArt, setBossArt] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    fetch('/api/game/raids.json', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      .then((r) => (r.ok ? (r.json() as Promise<RaidFeedResponse | null>) : null))
      .then((body) => {
        if (cancelled || !body?.data) return;
        const map = new Map<string, string>();
        for (const boss of body.data) {
          if (boss.name && boss.image) map.set(normaliseBossName(boss.name), boss.image);
        }
        setBossArt(map);
      })
      .catch(() => {
        /* No sprites, same board. Not worth surfacing. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    let connectTimer = 0;

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

      // See CONNECT_TIMEOUT_MS: a handshake that never resolves either way
      // gets forced closed so it is treated as a failed attempt instead of an
      // indefinite one.
      connectTimer = window.setTimeout(() => {
        connectTimer = 0;
        if (ws.readyState === WebSocket.CONNECTING) ws.close();
      }, CONNECT_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        window.clearTimeout(connectTimer);
        connectTimer = 0;
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
        window.clearTimeout(connectTimer);
        connectTimer = 0;
        stopHeartbeat();
        // Only a connection that actually held counts as success. A socket that
        // opens and dies immediately leaves `attempts` where it was, so the
        // backoff keeps growing and the board still falls through to polling.
        if (openedAt && Date.now() - openedAt >= STABLE_CONNECTION_MS) attempts = 0;
        openedAt = 0;
        socket = null;
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
      if (connectTimer) window.clearTimeout(connectTimer);
      stopHeartbeat();
      stopPolling();
      socket?.close();
      socket = null;
    };
  }, [applyEvent, refresh]);

  // --- the board's own states, printed into the log ------------------------
  /**
   * A state change writes one line. The pill above already carries the state
   * for anyone looking at the head of the page; the line is for anyone looking
   * at the log, and it is the only place that records *when* it happened.
   *
   * Not announced: the pill is the page's `role="status"` for connection, and
   * a second live region saying the same words would read it twice.
   */
  const [sysLog, setSysLog] = useState<SysLine[]>([]);
  const sysSeq = useRef(0);
  const lastStatus = useRef<ConnectionStatus>('connecting');
  /** Whether the socket has ever been in trouble. "Back on" is only news
   *  after something went wrong; on a first connection it is the normal path. */
  const hadTrouble = useRef(false);

  useEffect(() => {
    if (lastStatus.current === status) return;
    lastStatus.current = status;

    const text = SYS_LINE[status];
    if (!text) return;
    if (status === 'live' && !hadTrouble.current) return;
    if (status === 'reconnecting' || status === 'polling') hadTrouble.current = true;

    sysSeq.current += 1;
    const line: SysLine = { id: sysSeq.current, at: Date.now() + skewRef.current, text };
    setSysLog((prev) => [...prev, line].slice(-MAX_SYS_LINES));
  }, [status]);

  // --- actions ------------------------------------------------------------

  const loadPois = useCallback(async () => {
    if (poisRequested.current) return;
    poisRequested.current = true;
    try {
      // The map payload is the only public list of POIs and it is already
      // edge-cached, so this costs nothing on a warm cache — and nothing at all
      // for the majority of visitors, who never open the form.
      const res = await fetch('/api/map.json', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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

  /**
   * The compose form is a disclosure, not a modal: it does not cover the board
   * and nothing behind it is inert, so there is no focus trap. It still owes
   * the keyboard the two things a disclosure owes — focus moves into it when it
   * opens, and Escape closes it and hands focus back to the control that opened
   * it, rather than dropping the reader at the top of the document.
   */
  const raiseRef = useRef<HTMLButtonElement>(null);
  const composeHeadingRef = useRef<HTMLHeadingElement>(null);
  const wasFormOpen = useRef(false);

  useEffect(() => {
    if (formOpen) composeHeadingRef.current?.focus();
    else if (wasFormOpen.current) raiseRef.current?.focus();
    wasFormOpen.current = formOpen;
  }, [formOpen]);

  /** The Edit control a correction form was opened from, so Escape can go back. */
  const editReturnRef = useRef<HTMLButtonElement | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) editInputRef.current?.focus();
  }, [editing]);

  const closeEdit = useCallback(() => {
    setEditing(null);
    editReturnRef.current?.focus();
  }, []);

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

  const openEdit = (flare: Flare, from: HTMLButtonElement) => {
    editReturnRef.current = from;
    setEditing(flare);
    setEditBoss(flare.boss ?? '');
    setEditTier(flare.tier ?? '');
  };

  /*
   * Correcting a flare that is already out.
   *
   * Sends the fields as explicit values rather than omitting empty ones: the
   * endpoint treats an absent key as "leave alone" and a null as "clear", and
   * clearing a boss typed by mistake is half the reason this exists.
   */
  const saveEdit = async () => {
    if (!editing) return;
    setSavingEdit(true);
    try {
      const payload: { action: 'edit'; boss?: string | null; tier?: string | null } = {
        action: 'edit',
        boss: editBoss.trim() || null,
      };
      // Tier lives on raids only; sending it on any other kind is a 422.
      if (flareCarriesTier(editing.kind)) payload.tier = editTier.trim() || null;

      const res = await fetch(`/api/flares/${editing.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.status === 410) {
        setFlares((prev) => prev.filter((f) => f.id !== editing.id));
        notify('err', 'That flare just expired.');
        setEditing(null);
        return;
      }
      if (!res.ok) throw new Error(await readError(res));

      const body = (await res.json()) as { flare: Flare };
      upsert(body.flare);
      setEditing(null);
      notify('ok', 'Flare updated. Discord says the same.');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Could not update it');
    } finally {
      setSavingEdit(false);
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
    () => flares.filter((f) => !f.closedAt && Date.parse(f.expiresAt) > nowMs),
    [flares, nowMs],
  );

  /** The log itself: flares and the board's own states on one timeline,
   *  newest first, because the top of the board is what a glance reaches. */
  const log = useMemo<LogEntry[]>(() => {
    const rows: LogEntry[] = visible.map((flare) => ({
      kind: 'flare',
      at: Date.parse(flare.createdAt),
      flare,
    }));
    for (const line of sysLog) rows.push({ kind: 'sys', at: line.at, line });
    rows.sort((a, b) => b.at - a.at);
    return rows;
  }, [visible, sysLog]);

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
      count === 0 ? 'No flares active.' : `${count} ${count === 1 ? 'flare' : 'flares'} active.`,
    );
  }, [visible.length]);

  /*
   * The pill says whether the board is CONNECTED. It never says how many people
   * are here, and it no longer says "LIVE" over an empty board.
   *
   * It used to read "Live · N watching", and the count was the problem: on a
   * quiet evening it renders "Live · 1 watching", which tells a lone user they
   * are alone and invites them to close the tab. Justin's call (2026-08-16) was
   * to keep the reassurance and drop the headcount.
   *
   * Round 2 found the word itself wrong. A red pulsing "LIVE" 40px under the
   * nav's red disc, sitting above "Nothing on the board right now", claims the
   * loudest state this site has for the fact that a WebSocket opened. So the
   * word follows the board rather than the socket: `Connected` when the socket
   * is up and nothing is burning, `Live` (and the red, and the pulse) only once
   * a flare is actually on the board.
   *
   * `connecting` stays dropped. It is the normal path on every load, so showing
   * it buys a pill that flashes once and vanishes.
   *
   * `reconnecting` and `polling` are not decoration — they are the difference
   * between "nothing is happening" and "you are not being told what is
   * happening". A silent fallback to 20-second polling is exactly the failure a
   * live board must not hide.
   */
  const anyLive = visible.length > 0;
  const statusText =
    status === 'live'
      ? anyLive
        ? 'Live'
        : 'Connected'
      : status === 'reconnecting'
        ? 'Reconnecting'
        : status === 'polling'
          ? 'Refreshing every 20s'
          : null;
  /*
   * The modifier the red and the pulse hang off — the socket state alone never
   * earns them. A connected socket over an empty board is its own tone, so the
   * `--live` styling cannot reach it by accident.
   */
  const statusTone = status === 'live' ? (anyLive ? 'live' : 'connected') : status;

  const flareRow = (flare: Flare) => {
    const myState = mine[flare.id];
    const canAlter = mayAlterFlare(flare.author, currentUserId, canModerate);
    const art =
      flare.kind === 'raid' && flare.boss ? bossArt.get(normaliseBossName(flare.boss)) : undefined;

    /*
     * What this line is about, in one heading.
     *
     * A raid is its boss, a remote invite is the spaces left, and everything
     * else is the place it is happening — because "Gym takedown" as a heading
     * above a "Gym takedown" badge says the same word twice and tells nobody
     * where to walk. Only when a flare has neither a subject nor a place does
     * the kind become the heading.
     */
    const headline =
      flare.kind === 'raid' && flare.boss
        ? `${flare.boss}${flare.tier ? ` · Tier ${flare.tier}` : ''}`
        : flare.kind === 'remote_invites' && flare.needed
          ? `${flare.needed} space${flare.needed === 1 ? '' : 's'} open`
          : (flare.poi?.name ?? FLARE_KIND_LABEL[flare.kind]);
    const placeIsHeadline = headline === flare.poi?.name;
    const mapHref = flare.poi ? `/map?poi=${encodeURIComponent(flare.poi.slug)}` : null;

    return (
      <li key={`flare-${flare.id}`} className="card flare">
        <p className="flare-line">
          <time className="flare-time" dateTime={flare.createdAt}>
            {stamp(Date.parse(flare.createdAt))}
          </time>
          {/* The drawn kind, beside the word. `/go` has shown these six
              silhouettes since the flat SVGs landed and `/live` was still
              printing text chips, so the same six flares read as two different
              vocabularies depending which page you raised them from. */}
          <span className={`badge flare-kind flare-kind--${flare.kind}`}>
            <FlareIcon kind={flare.kind} size={13} className="flare-kind-icon" />
            {FLARE_KIND_LABEL[flare.kind]}
          </span>
          {/*
            Someone has said they are standing there. That is a fact about the
            flare, not a state of the board — so it is a printed badge, and the
            You-Are-Here marker with its pulse is kept for a flare that is
            genuinely live right now.
          */}
          {flare.rsvps.here > 0 && <span className="badge flare-attend">Someone&rsquo;s here</span>}
          <span className="flare-left">{timeLeft(flare.expiresAt, nowMs)}</span>
        </p>

        {/* A raid flare names a boss; showing the boss beats spelling it.
            Decorative: the title beside it already says the name, so
            announcing the image would just repeat it. */}
        {art && (
          <img
            className="flare-boss-art"
            src={proxiedImageUrl(art) ?? art}
            alt=""
            width="52"
            height="52"
            loading="lazy"
            decoding="async"
          />
        )}

        <h2 className="flare-title">
          {placeIsHeadline && mapHref ? (
            <a className="flare-place target" href={mapHref}>
              {headline}
            </a>
          ) : (
            headline
          )}
        </h2>

        {!placeIsHeadline &&
          (mapHref && flare.poi ? (
            <p className="flare-where">
              <a className="flare-place target" href={mapHref}>
                {flare.poi.name}
              </a>
            </p>
          ) : (
            <p className="flare-where flare-where--none">No location given</p>
          ))}

        {flare.note && <p className="flare-note">{flare.note}</p>}

        <p className="flare-meta">
          {flare.author ? (
            <span className="flare-author">
              <span
                className={`flare-team flare-team--${flare.author.team ?? 'none'}`}
                aria-hidden="true"
              />
              {flare.author.team && <span className="sr-only">Team {TEAM_LABEL[flare.author.team]}, </span>}
              {flare.author.name}
            </span>
          ) : (
            <span className="flare-author">
              <span className="flare-team flare-team--none" aria-hidden="true" />
              Someone
            </span>
          )}
          {flare.rsvps.coming + flare.rsvps.here > 0 && (
            <span className="flare-count">
              {flare.rsvps.coming} coming
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
                className="btn btn--sm btn--outline live-toggle"
                aria-pressed={myState === state}
                disabled={busyId === flare.id}
                onClick={() => void rsvp(flare, state)}
              >
                {RSVP_LABEL[state]}
              </button>
            ))}
            {/* Ids are compared explicitly in mayAlterFlare rather than via
                `a?.id === b?.id`, which is true when BOTH are absent — that
                would hand everyone an Edit/Close button on every authorless
                flare. */}
            {canAlter && flareCarriesBoss(flare.kind) && (
              <button
                type="button"
                className="btn btn--sm btn--outline"
                disabled={busyId === flare.id}
                onClick={(e) => openEdit(flare, e.currentTarget)}
              >
                Edit the boss
              </button>
            )}
            {canAlter && (
              <button
                type="button"
                className="btn btn--sm btn--outline live-close"
                disabled={busyId === flare.id}
                onClick={() => void close(flare)}
              >
                Close it
              </button>
            )}
          </div>
        )}

        {editing?.id === flare.id && (
          <form
            className="live-edit"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeEdit();
            }}
          >
            <div className="live-field">
              <label className="live-label" htmlFor={`${uid}-edit-boss`}>
                Boss
              </label>
              <input
                id={`${uid}-edit-boss`}
                ref={editInputRef}
                className="live-input"
                value={editBoss}
                onChange={(e) => setEditBoss(e.target.value)}
                placeholder="Leave empty to remove it"
                maxLength={80}
              />
            </div>
            {flareCarriesTier(flare.kind) && (
              <div className="live-field">
                <label className="live-label" htmlFor={`${uid}-edit-tier`}>
                  Tier
                </label>
                <input
                  id={`${uid}-edit-tier`}
                  className="live-input"
                  value={editTier}
                  onChange={(e) => setEditTier(e.target.value)}
                  placeholder="e.g. 5"
                  maxLength={24}
                />
              </div>
            )}
            <div className="live-actions">
              <button type="submit" className="btn btn--sm btn--primary btn--arrow" disabled={savingEdit}>
                {savingEdit ? 'Saving…' : 'Save changes'}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--outline"
                onClick={closeEdit}
                disabled={savingEdit}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </li>
    );
  };

  return (
    <div className="live">
      <header className="panel-head live-head">
        <h1>Live board</h1>

        {statusText && (
          <p className={`live-status live-status--${statusTone}`} role="status" aria-live="polite">
            <span className="live-dot" aria-hidden="true" />
            {statusText}
          </p>
        )}
      </header>

      <p className="live-lede">
        Raids, takedowns and trades happening right now. Flares expire on their own: raids after{' '}
        {FLARE_TTL_MINUTES.raid} minutes, trades after {FLARE_TTL_MINUTES.trade / 60} hours.
      </p>

      {toast && (
        <p className={`live-toast live-toast--${toast.kind}`} role="status">
          {toast.text}
        </p>
      )}

      {canPost ? (
        <section className="live-compose">
          {formOpen ? (
            <form
              className="panel live-form"
              onSubmit={submit}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setFormOpen(false);
              }}
              aria-labelledby={`${uid}-compose`}
            >
              <h2 id={`${uid}-compose`} ref={composeHeadingRef} tabIndex={-1}>
                Raise a flare
              </h2>

              <div className="live-field">
                <span className="live-label" id={`${uid}-kind`}>
                  What is happening
                </span>
                <div className="live-kinds" role="group" aria-labelledby={`${uid}-kind`}>
                  {FLARE_KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className="chip"
                      aria-pressed={form.kind === kind}
                      onClick={() => setField('kind', kind)}
                    >
                      <FlareIcon kind={kind} size={16} />
                      {FLARE_KIND_LABEL[kind]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="live-fields">
                <div className="live-field">
                  <label className="live-label" htmlFor={`${uid}-where`}>
                    Where
                  </label>
                  <select
                    id={`${uid}-where`}
                    className="live-select"
                    value={form.poiId ?? ''}
                    onChange={(e) =>
                      setField('poiId', e.target.value ? Number(e.target.value) : null)
                    }
                  >
                    <option value="">Anywhere</option>
                    {(pois ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="live-field">
                  <label className="live-label" htmlFor={`${uid}-expires`}>
                    Expires in
                  </label>
                  <select
                    id={`${uid}-expires`}
                    className="live-select"
                    value={form.minutes}
                    onChange={(e) => setField('minutes', e.target.value)}
                  >
                    <option value="">Default ({FLARE_TTL_MINUTES[form.kind]} min)</option>
                    <option value="15">15 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="60">1 hour</option>
                    <option value="120">2 hours</option>
                  </select>
                </div>
              </div>

              {form.kind === 'raid' && (
                <div className="live-fields">
                  <div className="live-field">
                    <label className="live-label" htmlFor={`${uid}-boss`}>
                      Boss
                    </label>
                    <input
                      id={`${uid}-boss`}
                      className="live-input"
                      value={form.boss}
                      onChange={(e) => setField('boss', e.target.value)}
                      placeholder="e.g. Azelf"
                      maxLength={80}
                    />
                  </div>
                  <div className="live-field">
                    <label className="live-label" htmlFor={`${uid}-tier`}>
                      Tier
                    </label>
                    <input
                      id={`${uid}-tier`}
                      className="live-input"
                      value={form.tier}
                      onChange={(e) => setField('tier', e.target.value)}
                      placeholder="e.g. 5"
                      maxLength={24}
                    />
                  </div>
                </div>
              )}

              {form.kind === 'remote_invites' && (
                <div className="live-field">
                  <label className="live-label" htmlFor={`${uid}-needed`}>
                    Spaces still open
                  </label>
                  <input
                    id={`${uid}-needed`}
                    className="live-input"
                    type="number"
                    min={1}
                    max={20}
                    value={form.needed}
                    onChange={(e) => setField('needed', e.target.value)}
                  />
                </div>
              )}

              <div className="live-field">
                <label className="live-label" htmlFor={`${uid}-note`}>
                  Note
                </label>
                <input
                  id={`${uid}-note`}
                  className="live-input"
                  value={form.note}
                  onChange={(e) => setField('note', e.target.value)}
                  placeholder="Starting in five, need three more"
                  maxLength={280}
                />
              </div>

              <div className="live-actions">
                <button
                  type="submit"
                  className="btn btn--primary btn--arrow"
                  disabled={busyId === 'new'}
                >
                  {busyId === 'new' ? 'Posting…' : 'Send it up'}
                </button>
                <button
                  type="button"
                  className="btn btn--outline"
                  onClick={() => setFormOpen(false)}
                  disabled={busyId === 'new'}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              ref={raiseRef}
              type="button"
              className="btn btn--primary btn--block btn--arrow"
              onClick={openForm}
            >
              Raise a flare
            </button>
          )}
        </section>
      ) : (
        <section className="panel live-gate">
          {signedIn ? (
            <>
              <p>
                Flares are for community members, and joining the Discord upgrades your account the
                next time you sign in.
              </p>
              <a
                className="btn btn--discord btn--arrow"
                href="https://discord.com/invite/2sYR5YdRpH"
                rel="noopener noreferrer"
              >
                Join the Discord
              </a>
            </>
          ) : (
            <>
              <p>Sign in with Discord to raise a flare or to say you are on your way.</p>
              <a className="btn btn--discord btn--arrow" href="/auth/login?next=%2Flive">
                Sign in with Discord
              </a>
            </>
          )}
        </section>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <ol className="live-log stack">
        {/*
          Two objects, not one.
          The dashed box is a status — it says the board is empty and nothing
          else. The invitation is a solid panel with real buttons under it, which
          is this world's rule: an empty state is a statement, and an offer
          belongs on a sign.
        */}
        {visible.length === 0 && (
          <li className="live-nothing">
            <div className="empty-state empty-art-bg live-empty">
              <p>
                Nothing on the board right now. A flare appears here the moment someone raises one,
                without a refresh.
              </p>
            </div>
            <div className="panel live-elsewhere">
              <p className="live-elsewhere-line">Somewhere to go in the meantime.</p>
              <div className="live-empty-actions">
                <a className="btn btn--outline btn--arrow" href="/map">
                  See the park map
                </a>
                <a className="btn btn--outline btn--arrow" href="/events">
                  This week&rsquo;s meetups
                </a>
                {canPost && (
                  <a className="btn btn--outline btn--arrow" href="/go">
                    Get a ping when a flare goes up
                  </a>
                )}
              </div>
            </div>
          </li>
        )}

        {log.map((entry) =>
          entry.kind === 'sys' ? (
            <li key={`sys-${entry.line.id}`} className="live-sys">
              <time className="flare-time" dateTime={new Date(entry.at).toISOString()}>
                {stamp(entry.at)}
              </time>
              <span>{entry.line.text}</span>
            </li>
          ) : (
            flareRow(entry.flare)
          ),
        )}
      </ol>
    </div>
  );
}
