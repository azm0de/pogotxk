import { useCallback, useEffect, useRef, useState } from 'react';
import { SignedOutError, signInHref } from '~/lib/client-api';
import './admin-ui.css';

/**
 * The small pieces every admin editor shares: the result toast, the
 * signed-out notice, the unsaved-work guard, and the loading / failed states.
 *
 * Each island used to grow its own copy of the toast, and the copies drifted in
 * the ways the admin audit (2026-10) found: success and error were the same red
 * (C-13 / D-07); two of the three live regions were mounted already holding
 * their text, so a screen reader could miss them (D-13); and a second message
 * inside the first one's timeout was cleared early by the first one's timer.
 */

export type ToastKind = 'ok' | 'err' | 'signedout';

export interface ToastMessage {
  kind: ToastKind;
  text: string;
}

/** How long a success stays up. Errors stay until dismissed or replaced. */
const OK_MS = 4000;

export function useToast() {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const timer = useRef<number | null>(null);

  const stopTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const clear = useCallback(() => {
    stopTimer();
    setMessage(null);
  }, []);

  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    // The previous message's timer must not clear this one (the old race).
    stopTimer();
    setMessage({ kind, text });
    if (kind === 'ok') {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setMessage(null);
      }, OK_MS);
    }
  }, []);

  /** Report a thrown error; a 401 becomes the signed-out notice. */
  const fail = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof SignedOutError) {
        stopTimer();
        setMessage({ kind: 'signedout', text: '' });
        return;
      }
      notify('err', err instanceof Error && err.message ? err.message : fallback);
    },
    [notify],
  );

  useEffect(() => stopTimer, []);

  return { message, notify, fail, clear };
}

/** A drawn tick — the world draws its icons rather than using glyphs. */
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M5 12.5l4.5 4.5L19 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The 401 answer: what happened, the way back, and that nothing was lost. */
export function SignedOutText() {
  return (
    <>
      You were signed out. <a href={signInHref()}>Sign in again</a> — your draft is still here.
    </>
  );
}

interface ToastProps {
  message: ToastMessage | null;
  onDismiss: () => void;
  /** Extra class for placement — the map floats it over the map. */
  className?: string;
}

/**
 * The result of the last action.
 *
 * The region itself is always in the DOM and only its contents change, which
 * is what makes a screen reader announce it (D-13; the `.posts-toast` pattern).
 * Success is ink on the panel with a drawn tick; an error is the live red with
 * the word "Error:" in front, so colour is never the only difference.
 */
export function Toast({ message, onDismiss, className }: ToastProps) {
  const kind = message?.kind;
  const isError = kind === 'err' || kind === 'signedout';
  return (
    <div
      className={['admin-toast', kind ? `admin-toast--${isError ? 'err' : 'ok'}` : '', className]
        .filter(Boolean)
        .join(' ')}
      role="status"
      aria-live="polite"
    >
      {message && (
        <>
          {kind === 'ok' && <CheckIcon />}
          <span className="admin-toast-text">
            {isError && <strong>Error: </strong>}
            {kind === 'signedout' ? <SignedOutText /> : message.text}
          </span>
          {isError && (
            <button type="button" className="admin-toast-close" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Warn before the tab is closed or reloaded with unsaved work. The browser
 * writes its own wording; all a page can do is ask for the prompt.
 */
export function useBeforeUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older engines still read the return value.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}

/** `true` when the person has asked for less motion — `scrollIntoView` obeys it. */
export function scrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined' || !window.matchMedia) return 'auto';
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

export type LoadState = 'loading' | 'ready' | 'failed' | 'signedout';

interface LoadNoticeProps {
  state: LoadState;
  /** What failed, in the person's words: "the posts". */
  what: string;
  error?: string | null;
  onRetry: () => void;
  className?: string;
}

/**
 * Shown in place of a list until its first fetch settles. Before this, a list
 * that failed to load showed its empty-state copy ("Nothing here yet"), which
 * is a different and wrong claim (admin audit, 2026-10).
 */
export function LoadNotice({ state, what, error, onRetry, className }: LoadNoticeProps) {
  if (state === 'ready') return null;
  if (state === 'loading') {
    return <p className={['admin-load', className].filter(Boolean).join(' ')}>Loading…</p>;
  }
  return (
    <div className={['admin-load admin-load--failed', className].filter(Boolean).join(' ')} role="alert">
      <p>
        {state === 'signedout' ? (
          <SignedOutText />
        ) : (
          <>
            Could not load {what}.{error ? ` ${error}` : ''}
          </>
        )}
      </p>
      {state === 'failed' && (
        <button type="button" className="btn btn--outline btn--sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
