/**
 * Asks for a password-reset link, posted to by `/admin/reset`.
 *
 * The one endpoint in this app that must answer a stranger and a real admin
 * identically, so almost everything below is about *not saying things*. Read
 * the enumeration note before changing any response in this file: the shape of
 * the answer is the feature.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT UNDER `/api/admin/`
 * ---------------------------------------------------------------------------
 *
 * The same reason `admin-login.ts` is not, one step further along. Everything
 * under `/api/admin/` is gated by the middleware's role check, so a route there
 * would answer 401 to precisely the caller it exists for — and that caller is
 * in a worse position than the one at the login form, because they have already
 * established they cannot sign in. It would also owe a row in
 * `test/admin/surface.ts`, a table about who may act on the admin console,
 * which is not the question this route answers.
 *
 * ---------------------------------------------------------------------------
 * FORM ENCODING ONLY, AND THE REASON IS CSRF
 * ---------------------------------------------------------------------------
 *
 * Identical to the login route, and it has to be. Astro's origin check is
 * content-type dependent — it compares `Origin` against the request URL for
 * form-like types and **skips `application/json` entirely** (see
 * `vault/Platform Limits and Traps.md`). Accepting JSON here would silently
 * remove the only CSRF protection this route has, and a cross-site page could
 * then make a visiting admin ask for a reset link — or, pointed at somebody
 * else's address, use a visitor's browser to mail a stranger.
 *
 * ---------------------------------------------------------------------------
 * EVERY ANSWER IS THE SAME ANSWER
 * ---------------------------------------------------------------------------
 *
 * Registered, not registered, no address on file, banned, cooling down, mail
 * provider refused, migration not applied yet: **303 to `/admin/reset?sent=1`**,
 * byte for byte. The page there says "if that address is on file, a link is on
 * its way" and never anything else.
 *
 * The one thing that answers differently is a string that is not an address at
 * all, which gets `?error=bad`. That is not a leak: it is decided from the
 * submitted characters with no database involved, so anybody can compute it
 * themselves, and the alternative — telling somebody who fat-fingered their own
 * address that a mail is on the way — is a recovery flow that fails silently
 * for the person it exists for.
 *
 * Timing is the other channel, and it is narrowed rather than closed. The
 * outbound mail is handed to `waitUntil`, so the one genuinely slow thing never
 * appears in the response at all — and unlike the login route's deliberate
 * refusal to defer its rehash, that costs nothing here, because waiting on
 * Resend is I/O rather than CPU and the budget being protected is CPU. What is
 * left is that issuing a token performs three D1 writes that the other paths do
 * not. That is the same order of difference the login route measures and
 * accepts (4 ms, two writes), on an endpoint an attacker cannot repeat for the
 * same account faster than the cooldown allows.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import {
  RESET_TTL_MS,
  requestReset,
  resetLink,
} from '~/lib/auth/password-reset';
import { recordAudit } from '~/lib/db/audit';
import { emailConfigured, normalizeEmail, sendEmail } from '~/lib/notify/email';

export const prerender = false;

/** See the header. Anything else is 415. */
const FORM_TYPE = 'application/x-www-form-urlencoded';

/** Everything here is a 303, and nothing here may be cached. */
function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      'cache-control': 'no-store',
      // A reset request carries an address. Nothing downstream needs to know
      // where the person came from, and a Referer travelling onward from a
      // page in this flow is the leak `/admin/reset/<token>` guards against
      // for the token itself.
      'referrer-policy': 'no-referrer',
    },
  });
}

/**
 * The only answer this route gives about an address.
 *
 * A function rather than an inline string so there is exactly one of it, and
 * so the fact that four code paths return the identical thing is visible at a
 * glance rather than being four coincidences.
 */
function acknowledged(): Response {
  return seeOther('/admin/reset?sent=1');
}

/** Minutes, for the mail. Derived, so the mail and the TTL cannot disagree. */
const TTL_MINUTES = Math.round(RESET_TTL_MS / 60_000);

/**
 * The message itself. Plain text, and deliberately short.
 *
 * What it does **not** contain is the interesting part. No login username: the
 * address is unique across admins, so the link already identifies exactly one
 * account, and the page behind the token names it to somebody who has proved
 * they hold the link. No mention of whether this address was found, because the
 * mail only exists when it was. Nothing that would embarrass anyone if the
 * mailbox turned out to be shared.
 *
 * The last paragraph is load-bearing rather than polite. Most people who
 * receive an unexpected reset mail have not been attacked — somebody typed the
 * wrong address — and the useful instruction for them is to do nothing, which
 * has to be stated or they will click the link to "check".
 */
function resetMessage(link: string): { subject: string; text: string } {
  return {
    subject: 'Reset your PoGo TXK admin password',
    text: [
      'Somebody asked to reset the password on a PoGo TXK admin account.',
      '',
      'Open this link to choose a new one:',
      '',
      link,
      '',
      `The link works once and stops working after ${TTL_MINUTES} minutes.`,
      'Setting a new password signs that account out everywhere it is signed in.',
      '',
      'If you did not ask for this, ignore this message. Nothing has changed,',
      'and the link expires on its own.',
    ].join('\n'),
  };
}

export async function POST(ctx: APIContext): Promise<Response> {
  const { request, url } = ctx;

  const contentType = (request.headers.get('content-type') ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== FORM_TYPE) {
    return new Response(`This endpoint accepts ${FORM_TYPE} only.`, {
      status: 415,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  // Parsed as a query string rather than through `formData()`, for the reason
  // spelled out in `admin-login.ts`: the content type is already pinned, so
  // there is no multipart case, and `request.text()` makes workerd warn once
  // per request on a body it does not consider text-ish.
  const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));

  const email = normalizeEmail(form.get('email'));
  if (!email) return seeOther('/admin/reset?error=bad');

  /*
   * No mail configuration, no token.
   *
   * Checked before any database work, so a deployment that has not turned mail
   * on does nothing at all here rather than accumulating links nobody can
   * receive — and, since a token that cannot be delivered still burns the
   * cooldown, so that an unconfigured deployment cannot lock an admin out of
   * asking again the moment it *is* configured.
   *
   * It is also the state this repository ships in and the state the test suite
   * forces (`vitest.config.ts` blanks both halves), which means the default
   * behaviour of this endpoint is to write nothing and send nothing. A control
   * that is only proven while configured is not proven; this one is shut by
   * default and `test/auth/admin-reset.test.ts` asserts it.
   */
  if (!emailConfigured(env)) return acknowledged();

  const outcome = await requestReset(env.DB, email);

  /*
   * Not an address we know, or one that already has a live link. Either way
   * nothing is written, nothing is sent, and nothing is audited.
   *
   * The audit silence is the same argument `admin-login.ts` makes for not
   * logging a failure against an unknown username: a row nobody's counter
   * bounds is a row anyone can append at will, and `audit_log` is readable by
   * every ambassador. A token that *was* issued is bounded by the cooldown, so
   * logging that one cannot be turned into an amplifier.
   */
  if (outcome.status !== 'issued') return acknowledged();

  const message = resetMessage(resetLink(url.origin, outcome.token));

  /*
   * Off the response path where there is a Worker context to hand it to, and
   * awaited otherwise — the same shape as the flare fan-out and
   * `settleAnnouncement`, because a detached promise is not guaranteed to
   * finish once the response is sent.
   *
   * The outcome is deliberately dropped. There is nothing this route could do
   * with "Resend refused it" that would not also tell the sender of the
   * request whether the address was real.
   */
  const work = sendEmail(env, {
    to: outcome.email,
    subject: message.subject,
    text: message.text,
  }).then(
    () => undefined,
    () => undefined,
  );

  const background = ctx.locals.cfContext;
  if (background) background.waitUntil(work);
  else await work;

  /*
   * The audit row names the account and nothing else.
   *
   * No address — `audit_log` is readable by every ambassador and an admin's
   * personal mailbox is not theirs to read. No token, obviously: an audit row
   * carrying a live reset link would make the log a credential store. No
   * outcome from the mail provider either, since that is a fact about the
   * address.
   *
   * `actorId` is null because nobody authenticated to get here — the whole
   * point is that the requester cannot prove who they are yet. `entityId` is
   * the account the link was issued for, which is what somebody reading this
   * log during an incident actually needs.
   */
  await recordAudit(env.DB, {
    actorId: null,
    action: 'reset-request',
    entity: 'admin_credentials',
    entityId: outcome.userId,
    diff: { method: 'email' },
  });

  return acknowledged();
}
