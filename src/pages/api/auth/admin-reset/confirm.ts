/**
 * Redeems a reset link and sets the new password. Posted to by
 * `/admin/reset/<token>`.
 *
 * This is the route that actually changes a credential, so the ordering below
 * is the part to read rather than the prose: **everything that can refuse is
 * checked before the token is spent, and the token is spent before the
 * password is hashed.**
 *
 *   1. Content type, token shape, password length, the two entries matching.
 *      All cheap, all decidable from the submitted bytes, and all of them
 *      must come first — a link burned because somebody typed fifteen
 *      characters instead of sixteen is a link they now have to request again,
 *      and the mail it arrives in has a five-minute cooldown in front of it.
 *   2. `consumeReset`, which is one atomic statement. Spending before hashing
 *      means a stranger firing garbage at this endpoint cannot make the Worker
 *      burn a PBKDF2 derivation per request on a 10 ms CPU budget.
 *   3. Hash, then apply.
 *
 * Like `admin-login.ts` this does not use `handler()` from `~/lib/api`: that
 * wrapper answers in JSON, which is a dead end for a top-level browser
 * navigation. Every path here is a **303** with a `Location`, so a refresh
 * cannot resubmit a password.
 *
 * ---------------------------------------------------------------------------
 * THE NEW PASSWORD NEVER GOES ANYWHERE BUT `hashPassword`
 * ---------------------------------------------------------------------------
 *
 * It is not logged, not audited, not put in a `Location`, not echoed into the
 * page on a validation failure, and not carried in the redirect that follows
 * one — the form is re-rendered empty and the person types it again. That is
 * the same standing rule `scripts/set-admin-password.ts` follows, and the same
 * reason `/admin/reset/<token>` carries no JavaScript: a value that never
 * reaches app code cannot be leaked by app code.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import {
  MIN_PASSWORD_LENGTH,
  applyNewPassword,
  consumeReset,
  resetPath,
  resetRowId,
} from '~/lib/auth/password-reset';
import { isResetToken } from '~/lib/auth/admin-path';
import { DEFAULT_ITERATIONS, hashPassword } from '~/lib/auth/password';
import { recordAudit } from '~/lib/db/audit';

export const prerender = false;

/** Form encoding only, for the CSRF reason argued in `admin-login.ts`. */
const FORM_TYPE = 'application/x-www-form-urlencoded';

function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      'cache-control': 'no-store',
      // The referring URL contains the token. Nothing this redirect leads to
      // needs it, and a browser that passes it onward has handed a live reset
      // link to whatever the next page loads.
      //
      // Safe on a redirect, unlike on the pages: it governs only the Referer
      // on the GET that follows, and the page that GET renders takes its
      // policy from its own response — so no form inherits this one. The
      // header of `/admin/reset/[token].astro` has the rest.
      'referrer-policy': 'no-referrer',
    },
  });
}

/** Back to the form the person is standing at, with a reason. */
function back(token: string, error: 'short' | 'mismatch'): Response {
  return seeOther(`${resetPath(token)}?error=${error}`);
}

export async function POST(ctx: APIContext): Promise<Response> {
  const { request } = ctx;

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

  const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));

  const token = form.get('token') ?? '';
  const password = form.get('password') ?? '';
  const again = form.get('confirm') ?? '';

  /*
   * A token that is not even the right shape never becomes a `Location`.
   * Without this check the value would be interpolated into a redirect path,
   * which is how a form field turns into an open redirect — the same class of
   * bug `safeNext` exists for on the other routes.
   */
  if (!isResetToken(token)) return seeOther('/admin/reset?error=link');

  /*
   * The same 16-character floor `scripts/set-admin-password.ts` enforces, and
   * it has to be the same one: two doors onto a single credential with two
   * standards means the weaker one is the real standard. The reasoning is
   * unchanged and is written out above `DEFAULT_ITERATIONS` — at 10,000 rounds
   * the cost is not what protects this password, its own entropy is.
   *
   * Counted in code points rather than UTF-16 units, so a passphrase with an
   * emoji or an accented character is measured the way a person would count it
   * rather than being credited with two characters for one.
   */
  if ([...password].length < MIN_PASSWORD_LENGTH) return back(token, 'short');

  /*
   * Typed twice and compared, for the reason the setter script gives: a typo is
   * accepted silently and discovered by the next person who tries to sign in.
   * It is less catastrophic than it used to be — that is the whole point of
   * this feature — but "less catastrophic" here means another round trip
   * through a mailbox behind a five-minute cooldown.
   */
  if (password !== again) return back(token, 'mismatch');

  const outcome = await consumeReset(env.DB, token);
  if (outcome.status !== 'valid') {
    // Straight back to the link's own page, which reads the token's state and
    // says which of expired, already-used or not-valid it is. One place
    // renders those three, rather than this route having its own opinion.
    return seeOther(resetPath(token));
  }

  const stored = await hashPassword(password, DEFAULT_ITERATIONS);

  const effects = await applyNewPassword(
    env.DB,
    outcome.userId,
    stored,
    await resetRowId(token),
  );

  /*
   * Should be unreachable: the only thing that removes an admin's credential
   * row is `deleteAccount`, which now clears outstanding links as it goes. If
   * it happens anyway, say so rather than redirecting to a success page having
   * changed nothing. The token is already spent at this point and stays spent,
   * which is correct — it was redeemed, there is simply nothing to redeem it
   * against.
   */
  if (!effects.credentialUpdated) return seeOther('/admin/reset?error=gone');

  /*
   * The completion row. `actorId` is the account this time — control of the
   * mailbox has now been demonstrated, which is the evidence the whole flow
   * is built on — where `reset-request` logs `null` because at that point
   * nobody had proved anything.
   *
   * The counts are here because they are what somebody reading this during an
   * incident wants: "did this sign the attacker out" is answered by
   * `sessionsRevoked`, and the answer is only meaningful if it was recorded at
   * the time. No address and no token, for the reasons on the request route.
   */
  await recordAudit(env.DB, {
    actorId: outcome.userId,
    action: 'reset-complete',
    entity: 'admin_credentials',
    entityId: outcome.userId,
    diff: {
      method: 'email',
      sessionsRevoked: effects.sessionsRevoked,
      tokensRevoked: effects.tokensRevoked,
    },
  });

  /*
   * To the sign-in form, **not** to a session.
   *
   * Minting one here would be convenient and is the wrong trade: the person
   * holding this link has proved they can read a mailbox, and the door they
   * are being let through is the one that is supposed to require a password.
   * Making them type the password they just chose costs a moment, proves they
   * actually captured it, and means a reset link is never itself a way in —
   * it only ever changes what the way in accepts.
   */
  return seeOther('/admin/login?reset=1');
}
