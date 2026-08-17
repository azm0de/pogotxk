import { useCallback, useEffect, useState } from 'react';

import './BubbleControl.css';

/**
 * Raises the floating ball from the page, when the page is running inside the
 * Android app.
 *
 * A web page cannot start an Android service on its own — there is no API for
 * it in any browser, and `SYSTEM_ALERT_WINDOW` is not reachable from
 * JavaScript. So the app injects a small bridge, and this component is the
 * half that looks for it.
 *
 * In an ordinary browser — desktop, mobile Chrome, an iPhone — the bridge is
 * simply absent and this renders NOTHING. That is deliberate: a visible
 * "Turn the bubble on" button that could never work is worse than no button,
 * and iOS in particular has no overlay capability at all, so there is nothing
 * to promise there.
 */

type BridgeState = {
  signedIn: boolean;
  canOverlay: boolean;
  running: boolean;
};

type Bridge = {
  state: () => string;
  start: () => void;
  stop: () => void;
};

declare global {
  interface Window {
    PogoTxkApp?: Bridge;
  }
}

/** Matches the constant the app dispatches after anything changes. */
const STATE_EVENT = 'pogotxk-bubble';

function readState(): BridgeState | null {
  const bridge = typeof window === 'undefined' ? undefined : window.PogoTxkApp;
  if (!bridge?.state) return null;
  try {
    const parsed = JSON.parse(bridge.state()) as Partial<BridgeState>;
    // The app answers `{}` to a page it does not recognise as ours. Treating a
    // missing field as "no" keeps that refusal from reading as "signed in".
    if (typeof parsed.signedIn !== 'boolean') return null;
    return {
      signedIn: parsed.signedIn,
      canOverlay: parsed.canOverlay === true,
      running: parsed.running === true,
    };
  } catch {
    return null;
  }
}

export default function BubbleControl() {
  const [state, setState] = useState<BridgeState | null>(null);

  const refresh = useCallback(() => setState(readState()), []);

  useEffect(() => {
    refresh();

    // The app fires this after the service starts or stops, and after the
    // overlay permission screen returns.
    window.addEventListener(STATE_EVENT, refresh);
    // Granting the overlay permission happens on an Android settings screen,
    // so the page is backgrounded while it changes and gets no event of its
    // own until it comes back.
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener(STATE_EVENT, refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [refresh]);

  // Not in the app, or the app refused the call: render nothing at all.
  if (!state) return null;

  const bridge = window.PogoTxkApp;
  if (!bridge) return null;

  if (!state.signedIn) {
    return (
      <p className="go-bubble-note">
        Sign in to use Raid Assist over Pokémon GO.
      </p>
    );
  }

  const running = state.running;

  return (
    <div className="go-bubble">
      <button
        type="button"
        className={running ? 'go-bubble-btn is-on' : 'go-bubble-btn'}
        onClick={() => (running ? bridge.stop() : bridge.start())}
      >
        <span aria-hidden="true">{running ? '✕' : '⦿'}</span>
        {running ? 'Turn Raid Assist off' : 'Launch Raid Assist!'}
      </button>
      <p className="go-bubble-note">
        {running
          ? 'It stays put over Pokémon GO. Tap it to flare without leaving the game.'
          : state.canOverlay
            ? 'Floats over Pokémon GO so you can flare without leaving the game.'
            : 'Android will ask permission to draw over other apps first — it cannot be granted from here.'}
      </p>
    </div>
  );
}
