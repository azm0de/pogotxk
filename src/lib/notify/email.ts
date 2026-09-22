/**
 * Transactional mail, via Resend.
 *
 * One caller today: the admin password reset. That is the whole reason this
 * exists, and it is worth saying out loud, because it sets the standard the
 * rest of this file is written to — the message this sends carries a working
 * link to change an admin's password, so "best effort" here does not mean the
 * same relaxed thing it means in `discord.ts`, where the worst case is a
 * community flare nobody saw.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE IS `discord.ts`'s, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 *   * `env` is a **parameter**, not a module-scope `cloudflare:workers` import.
 *     That is what lets a plain test call these functions with a hand-made
 *     object, and what lets `scripts/set-admin-password.ts` import
 *     `normalizeEmail` under `tsx` — which is the same constraint, and the same
 *     argument, as `src/lib/auth/password.ts`.
 *   * Outcomes are **returned and classified**, never thrown. A caller in the
 *     middle of a reset request must be able to answer the browser whatever
 *     Resend did, and it must answer the same thing either way — see the
 *     enumeration note on the route.
 *   * `AbortSignal.timeout`, so a slow third party cannot hold a request open.
 *   * The endpoint is **host-checked** before anything is sent.
 *
 * ---------------------------------------------------------------------------
 * PLAIN TEXT ONLY. NO HTML.
 * ---------------------------------------------------------------------------
 *
 * There is no `html` field here and there should not be one. Plain text has no
 * remote images, so it cannot carry a tracking pixel that tells a third party
 * when an admin opened a password-reset mail and from which IP. It renders
 * identically everywhere, including in the text-only clients and the notification
 * previews where somebody in a hurry will actually read it. And it is the shape
 * with the least to get wrong: no escaping, no link rewriting, no layout.
 */

/**
 * Resend's send endpoint, fixed.
 *
 * Not configurable, and `resendEndpoint()` below still checks its host. That
 * looks like checking a constant against itself, so here is why it is not
 * theatre: **this request carries the API key in an `Authorization` header.**
 * The realistic way this value ever becomes wrong is an edit — a typo, a
 * copy-paste from another provider's docs, a "let me point this at a staging
 * relay" that gets committed — and every one of those hands the credential to
 * whoever owns the host that ends up here, along with an admin's email address
 * and a live reset link. A wrong host is therefore not a failed send, it is a
 * disclosure, and the check is what makes that edit fail closed instead.
 *
 * It is the same argument `webhookUrl()` makes for the Discord webhook, which
 * is configurable and needs the check for the more ordinary reason. Mail here
 * needs it for the sharper one, which is why the endpoint is a constant: there
 * is no reason for this value to be operator-supplied, so it is not.
 */
export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** The only host this module will ever hand an API key to. */
const RESEND_HOST = 'api.resend.com';

/**
 * Exported for testing. Returns null unless the endpoint really is Resend's —
 * see the note above for why a constant is checked at all.
 */
export function resendEndpoint(): string | null {
  try {
    const parsed = new URL(RESEND_ENDPOINT);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname.toLowerCase() !== RESEND_HOST) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * An address, lowercased, or null.
 *
 * Deliberately stricter than RFC 5322, which permits quoted local parts,
 * comments and bracketed literal IP domains — none of which anybody is going
 * to type into a password-reset form, and all of which are shapes a later
 * reader would have to reason about. What is accepted is the ordinary
 * `local@domain.tld` with no spaces, no angle brackets, no commas and no
 * control characters, capped at 254 characters (SMTP's path limit).
 *
 * Lowercased because that is what the schema stores: `admin_credentials.email`
 * carries the same `= lower(...)` CHECK the `username` column does, so the
 * UNIQUE index and the lookup ask the same question and the index stays usable.
 * Domains are case-insensitive by spec and local parts are case-sensitive by
 * spec-and-nobody-in-practice; every mail provider that matters folds them, and
 * an admin who typed `Justin@` on Tuesday and `justin@` on Wednesday must not
 * silently get "no such account" — which, since this endpoint says the same
 * thing either way, they would never be told about.
 *
 * ---------------------------------------------------------------------------
 * THE APOSTROPHE AND THE BACKTICK ARE REFUSED, AND THAT IS A DECISION
 * ---------------------------------------------------------------------------
 *
 * Both are legal in an RFC 5322 local part, and `o'brien@example.com` is a
 * perfectly real address. They are refused anyway, because this validator is
 * shared with `scripts/set-admin-password.ts` and that script **interpolates
 * the result straight into SQL text** — `wrangler d1 execute --file` has no
 * parameter binding, which is why `assertB64Url` and `assertName` exist beside
 * it. A single quote is SQLite's string delimiter and a backtick is one of its
 * identifier quotes, so either one arriving in that statement turns it into a
 * different statement.
 *
 * The alternative was an escaping path in the setter — doubling the quote, the
 * one true SQLite escape. It was not taken. This repository's standing answer
 * to "a surprising value could change what a statement means" is to refuse the
 * value rather than to neutralise it, on the grounds that a refusal is
 * obviously correct at a glance and an escape is correct only if it is right,
 * and the cost here is an admin with an apostrophe in their address having to
 * use a different one for recovery. That is a rare inconvenience against a
 * class of bug this file would otherwise have to keep being right about.
 *
 * Found by `scripts/test-admin-password.ts`, which asserts the injection
 * shapes under `tsx` — the runtime the setter actually uses — rather than by
 * anyone reasoning about the character class.
 */
const ADDRESS = /^[a-z0-9!#$%&*+/=?^_{|}~-]+(?:\.[a-z0-9!#$%&*+/=?^_{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (value.length < 3 || value.length > 254) return null;
  return ADDRESS.test(value) ? value : null;
}

/**
 * The From address, from configuration, or null.
 *
 * **Never hardcoded, and there is no fallback.** The sending domain has to be
 * verified in Resend before Resend will accept mail from it, so a default
 * baked in here would be a default that bounces — and it would do it silently,
 * because this feature cannot tell the requester that delivery failed without
 * also telling a stranger which addresses are registered. A missing From is a
 * disabled sender, which is a state the reset flow already handles honestly.
 *
 * Resend accepts a bare address or a `Name <address>` display form. Only the
 * bare address is accepted here: the display form is a header-injection shape
 * (a newline inside the name would split the JSON field's meaning at the far
 * end) and it buys nothing this feature needs.
 */
export function emailFrom(env: Env): string | null {
  return normalizeEmail((env as unknown as Record<string, string | undefined>).RESEND_FROM);
}

/** The API key, or null when it is unset or blank. */
export function resendApiKey(env: Env): string | null {
  const key = (env as unknown as Record<string, string | undefined>).RESEND_API_KEY;
  return key ? key : null;
}

/**
 * Whether mail can be sent at all, without sending any.
 *
 * Both halves must be present. That is not belt-and-braces: it means the test
 * suite's blanked bindings close this path twice over, and it means a
 * half-finished production configuration cannot mint a reset token for a
 * message that will never arrive.
 */
export function emailConfigured(env: Env): boolean {
  return resendApiKey(env) !== null && emailFrom(env) !== null && resendEndpoint() !== null;
}

/**
 * What one send attempt did.
 *
 *   sent      Resend accepted it. Nothing more is owed.
 *   disabled  No key, no From, or an endpoint that failed the host check. Not
 *             a failure — a deployment that has not turned mail on — and the
 *             caller must not treat it as one.
 *   refused   Resend answered and said no in a way retrying cannot fix: a bad
 *             key, an unverified sending domain, a rejected recipient.
 *   retry     Rate limit, 5xx, timeout, network error. Nothing says the
 *             request was wrong.
 *
 * Four values rather than a boolean because the three failures mean different
 * things to an operator reading an audit row, and because collapsing `disabled`
 * into `refused` is how a feature ends up looking broken on every deployment
 * that simply has not configured it.
 */
export type EmailOutcome = 'sent' | 'disabled' | 'refused' | 'retry';

/**
 * Exported for testing: classifying a status is the whole decision and should
 * not need a network to check. Mirrors `deliveryOutcomeForStatus` in
 * `discord.ts`, including 429 counting as `retry` rather than as refusal.
 */
export function emailOutcomeForStatus(status: number): EmailOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 401 || status === 403 || status === 404 || status === 422) return 'refused';
  if (status === 400) return 'refused';
  return 'retry';
}

export interface EmailMessage {
  /** One recipient. This module has no bulk case and should not grow one. */
  to: string;
  subject: string;
  /** Plain text. See the header note — there is no HTML field on purpose. */
  text: string;
}

/**
 * Send one message.
 *
 * Returns `disabled` and makes **no outbound request at all** when the
 * configuration is incomplete or the recipient is not an address. That is the
 * default state of this repository — `.dev.vars.example` ships the names with
 * no values, and `vitest.config.ts` forces both to empty — so the sender being
 * inert unless somebody deliberately turned it on is the behaviour, not an
 * edge case. `test/00-safety.test.ts` asserts it, because a control is not
 * proven by the control being configured; it is proven by the path being shut.
 */
export async function sendEmail(env: Env, message: EmailMessage): Promise<EmailOutcome> {
  const endpoint = resendEndpoint();
  const key = resendApiKey(env);
  const from = emailFrom(env);
  const to = normalizeEmail(message.to);

  if (!endpoint || !key || !from || !to) return 'disabled';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ from, to, subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(5000),
    });
    return emailOutcomeForStatus(res.status);
  } catch {
    // Timeout or transport failure. Nothing says the request was wrong.
    return 'retry';
  }
}
