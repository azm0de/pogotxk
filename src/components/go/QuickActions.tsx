import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MapPoi } from '~/lib/db/map';
import type { SessionUser } from '~/lib/auth/types';
import { DISCORD_INVITE } from '~/lib/socials';
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

interface QuickActionsProps {
  user: SessionUser | null;
  /**
   * Slug of a POI to arrive pre-selected, from `/go?poi=<slug>`.
   *
   * This is how the map's "Flare this" button hands over: the trainer has
   * already told us where they are by tapping the pin, and asking again with a
   * dropdown would be the second half of a question they just answered.
   */
  initialPoi?: string;
}

export default function QuickActions({ user, initialPoi }: QuickActionsProps) {
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

  const [pushKey, setPushKey] = useState<string | null>(null);
  const [pushState, setPushState] = useState<'unknown' | 'off' | 'on' | 'blocked' | 'unsupported'>(
    'unknown',
  );
  const [pushBusy, setPushBusy] = useState(false);

  /**
   * The deep-linked POI, held until an action is opened and then spent.
   *
   * A ref rather than state because it must survive the POI list arriving
   * without re-running anything, and because "already used" is not something
   * the UI renders — once the trainer picks a different location by hand, the
   * link has done its job and must not reassert itself on the next action.
   */
  const pendingPoiRef = useRef<string | null>(initialPoi ?? null);

  /** The flare being corrected, and the values in the correction sheet. */
  const [editing, setEditing] = useState<Flare | null>(null);
  const [editBoss, setEditBoss] = useState('');
  const [editTier, setEditTier] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

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

  // --- push notifications ---------------------------------------------------
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setPushState('unsupported');
      return;
    }

    let cancelled = false;
    (async () => {
      const cfg = await fetch('/api/push/subscribe')
        .then((r) => r.json() as Promise<{ publicKey: string | null; enabled: boolean }>)
        .catch(() => null);
      if (cancelled) return;

      if (!cfg?.enabled || !cfg.publicKey) {
        setPushState('unsupported');
        return;
      }
      setPushKey(cfg.publicKey);

      if (Notification.permission === 'denied') {
        setPushState('blocked');
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration();
      const existing = await reg?.pushManager.getSubscription();
      if (!cancelled) setPushState(existing ? 'on' : 'off');
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const togglePush = useCallback(async () => {
    if (!pushKey) return;
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();

      if (existing) {
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        }).catch(() => undefined);
        await existing.unsubscribe();
        setPushState('off');
        say('ok', 'Notifications off.');
        return;
      }

      // Must be inside this click handler: iOS silently refuses a permission
      // request that is not driven by a user gesture, and reports nothing.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPushState(permission === 'denied' ? 'blocked' : 'off');
        say('err', 'Notifications were not allowed.');
        return;
      }

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: pushKey,
      });

      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error('Could not save the subscription');

      setPushState('on');
      say('ok', "Notifications on. We'll ping you when someone flares.");
    } catch (err) {
      say('err', err instanceof Error ? err.message : 'Could not change notifications');
    } finally {
      setPushBusy(false);
    }
  }, [pushKey, say]);

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

  /**
   * POIs valid for the open action, nearest first when we know where we are.
   *
   * Capped at 40 because a phone `<select>` of 104 parks entries is unusable —
   * but the cap must never swallow the POI that is currently selected. A
   * deep link from the map can name a gym on the far side of the park, and a
   * `<select>` whose value matches no option renders BLANK: the trainer would
   * see an empty Where field and no hint that we knew the answer.
   */
  const candidates = useMemo(() => {
    if (!action) return [] as { poi: MapPoi; d: number | null }[];
    const allowed = action.poiTypes;
    const list = pois.filter((p) => !allowed || allowed.includes(p.type));
    const ranked = here
      ? list
          .map((p) => ({ poi: p, d: distanceMeters(here, [p.lat, p.lng]) as number | null }))
          .sort((a, b) => (a.d ?? 0) - (b.d ?? 0))
      : list.map((p) => ({ poi: p, d: null }));

    const shown = ranked.slice(0, 40);
    if (poiId !== null && !shown.some((c) => c.poi.id === poiId)) {
      const selected = ranked.find((c) => c.poi.id === poiId);
      if (selected) shown.unshift(selected);
    }
    return shown;
  }, [action, pois, here, poiId]);

  const openAction = (def: ActionDef) => {
    setAction(def);
    setBoss('');
    setNeeded(1);
    setNote('');

    const allowed = def.poiTypes;
    const valid = pois.filter((p) => !allowed || allowed.includes(p.type));

    /*
     * A POI the trainer named by tapping a pin on the map beats the nearest one
     * we guessed at. Only spent once the list has actually loaded — otherwise a
     * fast first tap would burn the link against an empty array and silently
     * fall back to GPS, which is the one case where the deep link matters most
     * (someone who opened the map, found the gym, and has location denied).
     */
    if (pendingPoiRef.current && pois.length > 0) {
      const wanted = valid.find((p) => p.slug === pendingPoiRef.current);
      pendingPoiRef.current = null;
      if (wanted) {
        setPoiId(wanted.id);
        return;
      }
    }

    // Otherwise preselect the nearest valid location — usually the right
    // answer, and it turns a three-tap flow into one.
    const first = (() => {
      if (!here || valid.length === 0) return null;
      return valid.reduce((best, p) =>
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
          // Filled from the raid list rather than asked for: the tier is a
          // property of the boss, so a second field would only be a chance to
          // contradict the first. The column existed and nothing ever wrote to
          // it, which is why the Discord embed could not show a tier.
          tier: action.kind === 'raid' && boss ? tierForBoss(boss) || null : null,
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

  /*
   * Standing a flare down.
   *
   * Deliberately a close and not a delete. The flare has already been
   * broadcast — an embed in Discord, a push notification on people's phones —
   * and none of that can be recalled. Closing edits the embed to say it ended
   * and leaves the history intact; deleting the row would strand the embed in
   * the channel still advertising a raid, with nothing left to point an edit
   * at. See markFlareClosedInDiscord and the sweep in flare-closures.ts.
   */
  const closeFlare = async (flare: Flare) => {
    try {
      await api(`/api/flares/${flare.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'close' }),
      });
      await loadFlares();
      say('ok', 'Flare closed. Discord updated.');
    } catch (err) {
      say('err', err instanceof Error ? err.message : 'Could not close it');
    }
  };

  /**
   * The tier the raid list gives for a boss, or '' when we do not know it.
   *
   * The boss field is free text matched against the list at post time, so
   * someone can type a boss we have never heard of — that has to keep working,
   * and it just means we cannot fill the tier for them.
   */
  const tierForBoss = useCallback(
    (name: string) =>
      bosses.find((b) => b.name.toLowerCase() === name.trim().toLowerCase())?.tier ?? '',
    [bosses],
  );

  /** Only these two carry a boss at all — the API enforces the same rule. */
  const isEditable = (flare: Flare) => flare.kind === 'raid' || flare.kind === 'remote_invites';

  const openEdit = (flare: Flare) => {
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
      // Tier lives on raids only; sending it on an invites flare is a 422.
      if (editing.kind === 'raid') payload.tier = editTier.trim() || null;

      await api(`/api/flares/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      setEditing(null);
      await loadFlares();
      say('ok', 'Flare updated. Discord says the same.');
    } catch (err) {
      say('err', err instanceof Error ? err.message : 'Could not update it');
    } finally {
      setSavingEdit(false);
    }
  };

  const signedIn = Boolean(user);
  const canPost = user && user.role !== 'guest';
  /*
   * Ambassadors and admins can stand down anyone's flare, matching the rule the
   * API actually enforces in PATCH /api/flares/:id — a flare posted in error
   * outlives the poster's attention span. Kept in sync with /live.
   */
  const canModerate = user?.role === 'ambassador' || user?.role === 'admin';

  /*
   * Whoever raised it, plus ambassadors — the rule PATCH /api/flares/:id
   * actually enforces, mirrored here so the buttons match what will succeed.
   *
   * Ids are compared explicitly because `a?.id === b?.id` is true when BOTH are
   * absent, which would put these controls on every authorless flare.
   */
  const mayAlter = (flare: Flare) =>
    canModerate || (user != null && flare.author?.id === user.id);

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
        <div className="go-head-right">
          {canPost && (pushState === 'on' || pushState === 'off') && (
            <button
              type="button"
              className={`go-bell${pushState === 'on' ? ' is-on' : ''}`}
              onClick={() => void togglePush()}
              disabled={pushBusy}
              aria-pressed={pushState === 'on'}
              title={pushState === 'on' ? 'Notifications on' : 'Turn on notifications'}
            >
              <span aria-hidden="true">{pushState === 'on' ? '🔔' : '🔕'}</span>
              <span className="sr-only">
                {pushState === 'on' ? 'Turn notifications off' : 'Turn notifications on'}
              </span>
            </button>
          )}
          {user ? (
            <span className="go-user">{user.displayName}</span>
          ) : (
            <a className="go-signin" href="/auth/login?next=%2Fgo">
              Sign in
            </a>
          )}
        </div>
      </header>

      {pushState === 'blocked' && canPost && (
        <p className="go-note">
          Notifications are blocked for this site. Turn them back on in your browser settings if
          you want a ping when someone flares.
        </p>
      )}

      <section className="go-board" aria-label="Active flares">
        {flares.length === 0 ? (
          canPost ? (
            <p className="go-empty empty-art-bg">
              Nothing active right now. Fire one below when you are at a gym and want company.
            </p>
          ) : (
            /*
             * Someone who cannot post must not be told to "fire one below" at a
             * row of buttons they cannot press. And this is the screen people
             * install to a home screen, so an empty board is the one place with
             * room to say what the app is actually for — which it previously
             * did not, anywhere.
             *
             * No `empty-art-bg` here on purpose: the pin motif reads as "there
             * is nothing here", which is the wrong thing to say underneath a
             * description of what the thing does.
             */
            <div className="go-intro">
              <p className="go-intro-lede">Flares, so nobody raids alone.</p>
              <ul className="go-intro-list">
                <li>
                  <span aria-hidden="true">🔥</span> Call a raid and watch who is on their way
                </li>
                <li>
                  <span aria-hidden="true">📣</span> Offer remote invites going spare
                </li>
                <li>
                  <span aria-hidden="true">🔔</span> Get a ping the moment someone else flares
                </li>
              </ul>
              <p className="go-intro-foot">
                Built for one hand, at a gym, with the game open in the other app.
              </p>
            </div>
          )
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
                    <div className="go-flare-actions">
                      <button
                        type="button"
                        className={`go-join${state ? ' is-in' : ''}`}
                        onClick={() => void rsvp(flare, state ? 'out' : 'coming')}
                        aria-pressed={Boolean(state)}
                      >
                        {state ? 'In' : 'Join'}
                      </button>
                      {/* `user` is non-null inside canPost, but compare ids
                          explicitly: `a?.id === b?.id` is true when BOTH are
                          absent, which would hand everyone an End button on
                          every authorless flare. */}
                      {mayAlter(flare) && isEditable(flare) && (
                        <button
                          type="button"
                          className="go-standdown"
                          onClick={() => openEdit(flare)}
                          title="Change the boss or tier"
                        >
                          Edit
                        </button>
                      )}
                      {mayAlter(flare) && (
                        <button
                          type="button"
                          className="go-standdown"
                          onClick={() => void closeFlare(flare)}
                          title="End this flare and strike it through in Discord"
                        >
                          End
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/*
       * Sits directly above the action grid, so the way out of the gate is
       * under the same thumb as the buttons it is gating.
       *
       * The guest wording used to read "ask an ambassador on Discord", which
       * sends someone to ask for something nobody has to grant: `resolveRole`
       * upgrades on guild membership alone, so joining is the whole of it and
       * it takes effect on their next sign-in. Same wording as /live now.
       */}
      {!canPost && (
        <p className="go-gate">
          {signedIn ? (
            <>
              Flares are for community members.{' '}
              <a href={DISCORD_INVITE} rel="noopener noreferrer" target="_blank">
                Join the Discord
              </a>{' '}
              and your account will be upgraded on your next sign-in.
            </>
          ) : (
            <>
              <a href="/auth/login?next=%2Fgo">Sign in with Discord</a> to fire a flare, join
              someone else&rsquo;s, or get a ping when one goes up.
            </>
          )}
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
                {candidates.map(({ poi, d }) => (
                  <option key={poi.id} value={poi.id}>
                    {poi.name}
                    {d === null ? '' : ` — ${fmtDistance(d)}`}
                  </option>
                ))}
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

      {/*
        Hoisted out of the action sheet so BOTH sheets can point at it. A
        datalist only exists while it is rendered, and the edit sheet is never
        open at the same time as the one this used to live inside — the boss
        suggestions would simply have been missing there. It renders nothing.
      */}
      <datalist id="go-bosses">
        {bosses.map((b) => (
          <option key={`${b.tier}-${b.name}`} value={b.name}>
            {b.tier}
          </option>
        ))}
      </datalist>

      {editing && (
        <div className="go-sheet-backdrop" onClick={() => setEditing(null)}>
          <section
            className="go-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Correct this flare"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <span aria-hidden="true">✏️</span>
              <div>
                <h2>Fix the details</h2>
                <p>Everyone on the board and in Discord sees the correction.</p>
              </div>
              <button type="button" className="go-close" onClick={() => setEditing(null)} aria-label="Close">
                ×
              </button>
            </header>

            <label className="go-field">
              <span>Boss</span>
              <input
                list="go-bosses"
                value={editBoss}
                onChange={(e) => {
                  setEditBoss(e.target.value);
                  // Picking a known boss fills the tier in, because the two
                  // always agree and asking twice is a tax paid at a gym.
                  const t = tierForBoss(e.target.value);
                  if (t) setEditTier(t);
                }}
                placeholder="Leave empty to remove it"
                maxLength={80}
              />
            </label>

            {editing.kind === 'raid' && (
              <label className="go-field">
                <span>Tier</span>
                <input
                  value={editTier}
                  onChange={(e) => setEditTier(e.target.value)}
                  placeholder="e.g. Tier 5"
                  maxLength={24}
                />
              </label>
            )}

            <button type="button" className="go-fire" onClick={() => void saveEdit()} disabled={savingEdit}>
              {savingEdit ? 'Saving…' : 'Save changes'}
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
