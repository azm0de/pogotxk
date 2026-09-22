---
tags: [architecture, security]
updated: 2026-09-22
---

# Auth and Roles

Discord is the sign-in method for everyone. The community already lives there, so guild
membership *is* the membership check — see [[Why Discord is the identity provider]].

There is one other door, and it is not for members: the admin password at `/admin/login`.
The accounts behind it are standalone identities with no Discord account of their own — see
[[#The admin password door]]. Since 2026-09-22 that door has a recovery path, `/admin/reset`,
which mails a link — and which makes admin access depend on a mailbox as well as on a
password. Read [[#Password reset by email]] before assuming the old threat model.

## Flow

1. `/auth/login` generates a CSRF `state` and a PKCE verifier, parks both in a ten-minute
   HttpOnly cookie, and redirects to Discord.
2. `/auth/callback` checks the returned state against that cookie, exchanges the code with the
   verifier, reads the profile and guild roles, and issues a session.
3. Middleware resolves the cookie into `Astro.locals.user` on every request.

Scopes requested: `identify` and `guilds.members.read`. No email, no messages, no bot.

## Roles

| Role | Means | Can |
|---|---|---|
| `guest` | Signed in, not in the guild | Read |
| `member` | In the guild | Fire flares, RSVP |
| `ambassador` | Has the ambassador role | Everything in `/admin` |
| `admin` | Has the admin role, or is `DISCORD_BOOTSTRAP_ADMIN_ID`, or holds `role_locked = 1` | Also: hard delete, import, settings |

## The admin password door

`/admin/login` is a username-and-password login, and the accounts it serves are **standalone
identities**: a `users` row under a synthetic `admin:<name>` id, a row in `admin_credentials`,
and no Discord account anywhere behind it. An admin does not have a Discord sign-in that would
also work; the password is the whole of their access. Production holds two of them.

It was built for the day Discord sign-in could not produce an admin. That day is now every
day: no `DISCORD_ROLE_ADMIN` is set, so `resolveRole` can only answer `member`, and
`DISCORD_BOOTSTRAP_ADMIN_ID` — the one remaining short-circuit — is being retired. Once that
secret is removed, nothing reachable through Discord resolves to `admin` at all.

> [!important] The path is not a secret, and nothing may be built on the idea that it is
> The repository (`azm0de/pogotxk`) is **public**, so every path written in it is public
> knowledge the moment it is committed. An unguessable path was considered for this page and
> rejected on exactly that ground: there is nowhere to hide one.
>
> So `/admin/login` is fixed and ordinary. Nothing links to it and it carries `noindex`, which
> keeps a password form out of the nav and out of a search index — tidiness, not defence.
> **The password and the lockout are the controls.** If a future change is ever justified by
> "nobody knows the URL", that justification is false and the change is unsafe.

The page sits under `/admin` and the POST route deliberately does not.

- `/admin/login` is inside the admin gate, so it needs an exemption to be reachable at all:
  `isAdminLoginPath` in `src/lib/auth/admin-path.ts`, wired into `src/middleware.ts` beside the
  import exemption. It is an **exact string match**, not a prefix and not `isUnder` — either of
  those would carry `/admin/login/anything` or `/admin/logins` out of the gate with it, turning
  one deliberate hole into an open-ended one nobody would have to notice. `admin-path.test.ts`
  pins the near-misses; `admin-login.test.ts` pins them again through the real stack.
- `POST /api/auth/admin-login` is **not** under `/api/admin/`, because everything there is
  gated and a gated login route would answer 401 to precisely the signed-out visitor it is for.
  It sits with `device/` and `mobile.ts` instead — the other routes that turn a credential into
  a session.
- It is **not** in `Admin.astro`'s nav. That layout is for signed-in admins, and every entry in
  its list must resolve to a page they can reach.

> [!danger] Why it had to exist
> `DISCORD_GUILD_ID` is set and the `DISCORD_ROLE_*` ids are not. So `resolveRole` falls
> through to `member` for every guild member — and because a guild *is* configured, Discord is
> **authoritative**, so `upsertUser` writes that answer. A hand-promoted admin is therefore
> demoted by their own next sign-in.
>
> That left exactly one path to `admin`: `DISCORD_BOOTSTRAP_ADMIN_ID`, a secret that
> short-circuits `resolveRole` for one Discord account. One account, one secret, one
> third-party service, and no recovery if any of the three is lost. Setting the
> `DISCORD_ROLE_*` ids would have fixed the demotion but not the single point of failure — it
> would just have moved it into the Discord server's role configuration.

> [!important] The secret is being retired, and the standalone identities are the replacement
> `DISCORD_BOOTSTRAP_ADMIN_ID` is the single point of failure this door was built to remove,
> so keeping both is keeping the problem. The owner removes the secret from the Worker
> himself; the code still honours it if it is set, and `resolveRole`'s bootstrap branch and
> its tests are unchanged.
>
> After it is gone the roles table below still reads correctly — it describes what the code
> does — but only one of its three routes to `admin` can actually fire on this deployment:
> `role_locked = 1`, which is what `scripts/set-admin-password.ts` writes. Setting
> `DISCORD_ROLE_AMBASSADOR` would still let Discord mint an **ambassador**, who can reach
> `/admin`; it would not mint an admin.

**How it works.** The password proves *which existing `users` row you are*, and everything after
that is the code every other door already runs: `createSession`, the same `sessions` table, the
same `pogotxk_session` cookie. The identity is standalone; the **session machinery is not** —
there is one `users` table, one role source and one ban check, and this door resolves through
all three like every other. That is the same claim `/auth/device` makes, and it is what
[[Data Model]] means by keying `admin_credentials` on `user_id`.

- The credential lives in `admin_credentials`, keyed `user_id` — see [[Data Model]].
- PBKDF2-HMAC-SHA256, 16-byte salt, 32-byte output, unpadded base64url. The iteration count is
  stored **in the row**, so it can be raised without invalidating the hash: verification uses
  the count it finds, and a successful login re-derives at the current one.
- `src/lib/auth/password.ts` carries no `cloudflare:workers` import and no `~/` alias, so
  `scripts/set-admin-password.ts` imports the very same module under plain `tsx`. The RFC
  known-answer vector is asserted in *both* test layers, which is what actually proves the
  hash written from Node verifies inside workerd.

> [!warning] The iteration count is the CPU budget's floor, so it is not what makes this hard
> Measured inside workerd on 2026-09-19: PBKDF2 here is linear at **0.53 ms per 1,000
> iterations**. This account is on Workers Free, confirmed from the dashboard, which caps a
> request at **10 ms of CPU** — so the 100,000 this started at wanted roughly five times the
> budget and would have been killed mid-derivation. `DEFAULT_ITERATIONS` is now **10,000**
> (~5 ms), which is also the floor the schema enforces.
>
> Be straight about what that costs. Online guessing is stopped by the lockout, not the cost.
> Offline, against a leaked dump, 10,000 rounds buys very little, so **the password's own
> entropy has to carry it** — which is why the setter leads with a generated six-word
> passphrase and says plainly that a memorable password is not well protected here. Workers
> Paid ($5/month) raises the budget to 30 s, where OWASP's 600,000 fits comfortably; raising
> the constant then costs one line and invalidates no stored hash, because the count lives in
> the row. The full numbers are in the comment above `DEFAULT_ITERATIONS`.

### `role_locked`

A `users` column, set by the setter script alongside the password. `upsertUser`'s `CASE` checks
it **before** it checks whether Discord is authoritative, and the order is the whole of the
change — SQLite takes the first true branch, and `authoritative` is permanently 1 here, so a
lock clause below it would never once fire.

It reads `users.role_locked`, never `excluded.role_locked`: the INSERT column list does not
mention the column, so the `excluded` form evaluates to the declared default of 0 and the lock
silently never fires. Both halves are tested, the second as the control — without it the first
passes against a `CASE` that does nothing.

> [!important] The lock pins the role. It does not survive a ban.
> Deliberate. `getSessionUser` returns undefined for `is_banned = 1` before it ever reads the
> role, so banning stays the emergency off-switch even against a locked admin. A flag that also
> defeated a ban would be a permanent un-revocable admin — a second copy of the single point of
> failure this feature exists to remove.

### Lockout

Five wrong passwords shut the door. The schedule escalates and is **capped at one hour**:
1 minute, then 5, then 30, then 60 and no further.

The cap is the design, not a rounding-off. The person locked out is an admin, whose account has
no Discord sign-in behind it — there is no other door for them to try and nobody above them to
ask. An unbounded schedule would be a denial of service aimed at the few people who cannot
route around it, triggerable by anyone who knows the username. The lock is per credential row,
so locking one admin out does not touch the other.

- The counter **decays on the next attempt**, not on a sweep — a failure whose predecessor is
  older than 24 hours starts again at 1. There is no cron here ([[Why there is no cron]]), so
  this is the same shape the announcement and flare sweeps take.
- The increment is a single SQL statement with the decay rule inside it, so two simultaneous
  attempts cannot both read 4 and both write 5.
- **A correct password while locked is still refused**, and `failed_attempts` is left alone.
- The locked path does **not** hash. The response says "locked" out loud on purpose — the admin
  has to be able to tell a wrong password from a wait — so spending a full PBKDF2 to hide a
  fact the message already states would only hand an attacker a way to burn the CPU budget.

### What it refuses to say

A wrong password, an unknown username, a username with no credential, and a row too corrupt to
check are all the same answer: `303` to `/admin/login?error=bad`, byte for byte. An unknown
username burns a real derivation first so the timing matches — measured at 56 ms against the
wrong-password path's 60 ms, the 4 ms being two D1 writes.

The audit log records failures with **no username and no password**, because one day an admin
will type their password into the username field and `audit_log` is readable by every
ambassador. A failure against an unknown username is not logged at all: it has no counter to
bound it, so logging it would let anyone append to `audit_log` at will.

## Password reset by email

Added 2026-09-22. `/admin/reset` takes an address, mails a link, and the link sets a new
password. Migration `0005_admin_password_reset.sql`.

> [!danger] This changed the admin door's threat model, and the change is not small
> Until now the door depended on exactly two things: D1, and the password. It now also
> depends on **an email provider and on the admin's mailbox being secure**, because anyone
> who can read that mailbox can take the account. The door is as strong as the *weaker* of
> the password and the mailbox, not as strong as the password.
>
> That is the deliberate trade. An account with no recovery path is one forgotten passphrase
> away from being gone — the setter script used to say so in three places and the lockout is
> capped at an hour for the same reason — and a mailbox is a thing an admin already protects.
>
> **It is opt-in per admin.** `admin_credentials.email` is nullable and both production rows
> have no address, so nothing is reset-able until somebody sets one. An admin who would
> rather keep the narrower model simply never does, or clears it again with
> `--clear-email`. Choose a mailbox with its own strong password and two-factor, and not one
> shared with anybody.

**The flow.** `/admin/reset` (form) → `POST /api/auth/admin-reset` (issue + mail) →
`/admin/reset/<token>` (form) → `POST /api/auth/admin-reset/confirm` (apply) →
`/admin/login?reset=1`. It ends at the sign-in form and **not at a session**: the link proves
control of a mailbox, and this door is the one that is supposed to require a password, so a
reset link only ever changes what the door accepts rather than opening it.

- **The token is the session scheme, not a second one.** 32 random bytes from `randomToken()`
  in the link, their SHA-256 in `admin_password_resets.id` — exactly as a session cookie
  relates to `sessions.id`. A leaked dump yields no usable links.
- **Thirty minutes, once.** `used_at` is stamped by a single atomic `UPDATE ... WHERE used_at
  IS NULL ... RETURNING`, so two simultaneous confirms cannot both win. Expired and
  already-used are told apart in the message, which costs nothing — the token is spent either
  way — and saves the admin who clicked twice from thinking the site is broken.
- **Issuing supersedes.** A new link deletes that account's older ones, so there is never
  more than one live link per admin. Two would have no legitimate use and one obvious abuse.
- **A completed reset destroys every session for that user** and every other outstanding
  link, in one batch. A reset is what somebody does after a compromise; an attacker's session
  outliving the password change would defeat the whole exercise. It signs the admin's own
  other devices out too, which is correct — "something is wrong" and "keep my phone signed
  in" cannot both be honoured.
- **It clears the lockout**, so an admin who was locked out can use the new password
  immediately. Proving control of the mailbox is stronger evidence than the counter it
  clears, and the lock exists to stop guessing, which is not what happened.
- **The new password goes through the same `hashPassword` and the same 16-character floor**
  the setter enforces. Everything decidable from the submitted bytes — the token's shape, the
  length, the two entries matching — is checked **before** the link is spent, so a typo does
  not cost a round trip through a mailbox. The token is spent **before** the hash is derived,
  so garbage cannot make the Worker burn PBKDF2 on a 10 ms budget.

### What the request endpoint refuses to say

Registered, not registered, no address on file, banned, cooling down, mail refused, migration
not yet applied: **303 to `/admin/reset?sent=1`**, byte for byte. The page says *"if that
address is on file, a link is on its way"* and never anything else — not "check your inbox",
which implies one was sent, and never "no such account".

The one thing that answers differently is a string that is not an address at all
(`?error=bad`). That is decided from the submitted characters with no database involved, so
anyone can compute it themselves, and the alternative is a recovery flow that fails silently
for somebody who fat-fingered their own address.

Timing is narrowed rather than closed: the outbound mail is handed to `waitUntil`, so the one
genuinely slow thing never appears in the response. (Deferring is right here and wrong for the
login route's rehash — waiting on Resend is I/O, and the budget being protected is CPU.) What
remains is that issuing performs three D1 writes the other paths do not, which is the same
order of difference the login route measures and accepts.

Audit rows carry **no address and no token**: `reset-request` (actor null — nobody had proved
anything yet) and `reset-complete` (actor is the account, plus the session and token counts
somebody will want during an incident). Nothing is logged for an address we do not know — a
row nobody's counter bounds is a row anyone can append at will, exactly as for an unknown
username at the login route.

### Rate limit: a per-account cooldown

**Five minutes.** A live, unused, unexpired link suppresses the next one for that account.

Per-account is the right axis. The harm here is not guessing — the token is 256 bits — it is
**mailing a real person over and over**, which anyone who knows an admin's address could
otherwise do for free and which no amount of token entropy touches. Binding it to the account
holds however the requests arrive: one browser, a script, or a thousand IPs all hit the same
ceiling, where an IP limit would have held against none of them.

Five rather than the full thirty-minute TTL, because the admin whose first mail went to spam
is the person this feature is for and telling them to wait half an hour is telling them the
break-glass door has a queue. It caps a mailbox at twelve messages an hour, and only for an
address genuinely on file. A spent or expired link does not suppress anything.

> [!note] What was considered and not added
> An IP or global limit. It would not bound the mailbox — the thing actually at risk — and
> without a rate-limiting binding or KV counter it would cost a write per request to
> approximate badly. What is left unbounded is Worker invocations from a distributed
> attacker, which costs money rather than safety and is Cloudflare's layer to answer, and it
> writes nothing: an unknown address performs one `SELECT` and no writes at all.

### The pages, and the second hole in the gate

Both reset pages sit under `/admin` and are exempted by `isAdminResetPath` — a **second exact
match** beside `isAdminLoginPath`, not a widening of it.

- `/admin/reset` is matched exactly.
- `/admin/reset/<token>` cannot be an equality check, because the path differs every time, so
  it is pinned to the **shape of the thing it must admit**: one segment, 64 lowercase hex
  characters. `/admin/reset/`, `/admin/resets`, `/admin/reset-notes`, anything nested below a
  token, an uppercase token and a token of any other length all stay gated.
- The cost is honest: somebody who clicks a *truncated* link is bounced to Discord sign-in
  rather than told the link is broken. That is one confusing minute occasionally, against an
  exemption that cannot be talked into covering a page nobody has written yet.

Both reset pages send **`Referrer-Policy: strict-origin`**. The token is in the URL of
`/admin/reset/<token>` — unavoidable, it is how a mailed link carries a credential — so without a
policy a single click on an outbound link hands a live reset link to whoever is on the other
end. `strict-origin` never sends a path, so the most a `Referer` from either page can carry is
the bare origin.

It is **not `no-referrer`**, which is what the flow shipped with and what OWASP's Forgot Password
Cheat Sheet recommends. A form inherits its page's policy, and under `no-referrer` the browser
posts `Origin: null`, which Astro's CSRF check refuses with a 403 — so neither form could be
submitted from a real browser ([[Platform Limits and Traps]]). The token is just as safe under
`strict-origin`; what `no-referrer` withholds beyond it is the bare origin, which is public. The
303s in the flow do keep `no-referrer`: a redirect's policy governs only the `Referer` on the GET
that follows it, and the page that GET renders takes its policy from its own response.

The redemption page's own content carries no external links, no images and no scripts. The
layout around it links out to Discord and the other socials, and each of those links carries
`rel="noreferrer"`. `Cache-Control: no-store` rides along.

### It is off unless configured, and that is the default

`RESEND_API_KEY` and `RESEND_FROM` — both, or the endpoint is inert and writes nothing. See
[[Configuration]]. `src/lib/notify/email.ts` sends **plain text with no HTML part**, so there
is no remote image that could tell a third party when an admin opened a password-reset mail
and from where, and it host-checks its endpoint because the request carries the API key in a
header: a wrong host would be a disclosure rather than a failed send.

> [!warning] Resend is the second outbound sender, and it gets the webhook's treatment
> `vitest.config.ts` blanks both bindings, `test/00-safety.test.ts` proves they are blank and
> that `sendEmail` refuses without them, and `test/setup.ts` makes any unstubbed `fetch`
> throw. This is the rail that exists because a local test once posted a real embed into the
> live Discord ([[Bugs Worth Remembering]]), and the blast radius here is worse: a mail is a
> password-reset link delivered to somebody's actual inbox, and it cannot be unsent.

### Setting the password

```bash
npm run set:password -- --discord-id <snowflake>   # an existing users row
npm run set:password -- --create <name>            # a standalone admin identity
npm run set:password -- --create <name> --email you@example.com
npm run set:password -- --create <name> --clear-email
```

`--create` is the one that made the two accounts in production. It is not an emergency path any
more; it is how an admin is made.

> [!danger] It must be run from a real console, and it refuses otherwise
> Under Git Bash / mintty, `node` is handed a pipe rather than a console: `stdin.isTTY` is
> `undefined`, readline's private `_writeToOutput` override silently does nothing, and **the
> password echoes in plain text** while looking like it worked. Echo cannot be suppressed on a
> pipe, so the script stops rather than guessing. Use PowerShell or Windows Terminal, or
> prefix with `winpty`.

The password is never a CLI argument, never piped, never displayed — the same standing rule
that produced the VAPID procedure in [[Configuration]]. It is prompted twice and compared,
because a typo'd password is discovered by whoever next tries to use it: for a standalone
identity there is no Discord sign-in to fall back on, and the only other way out is the reset
link, which needs an address on file and lands in a mailbox behind a cooldown. The minimum is
16 characters.

`--email` sets or changes the recovery address and `--clear-email` removes it; leaving both
flags off leaves whatever is on file alone, so rotating a password never silently wipes an
address. The address is validated by the app's own `normalizeEmail`, checked against the
UNIQUE constraint **before** the password prompt (the same lesson the login-name collision
taught), and **every run revokes that admin's outstanding reset links** — a link issued a
minute earlier would otherwise still be able to replace the password just chosen. That
revocation is a separate statement from the main write, so a database where `0005` has not
been applied reports it rather than failing the password write.

> [!note] An apostrophe in an address is refused, deliberately
> `o'brien@example.com` is a real address and `normalizeEmail` rejects it, along with the
> backtick. The setter interpolates this value straight into SQL text — `--file` has no
> parameter binding, which is why `assertB64Url` and `assertName` exist beside it — and a
> single quote is SQLite's string delimiter. The repo's standing answer to that is to refuse
> the value rather than escape it. Caught by `scripts/test-admin-password.ts` asserting the
> injection shapes under `tsx`, not by anyone reading the character class.

`--discord-id` refuses a snowflake with no `users` row rather than inventing one: a row keyed to
a made-up id means the next real sign-in inserts a *second* row for the same person, because
`upsertUser` matches on `discord_id`. `--create` mints a deliberately **non-numeric** synthetic
id (`admin:<name>`) that can never collide with a real snowflake — the same property
`anonymizedIdentity` relies on for `deleted:<id>`, and what makes the identity standalone: no
Discord sign-in can ever reach the row, whoever signs in. It also writes `global_name` as the
capitalised name, so `--create nic` gives `Nic`.

> [!warning] The prefix has to stay `admin:`
> Production holds `admin:nic` and `admin:justin`. A script minting under any other prefix
> would not fail — it would quietly start a second convention and a second account for a name
> that already has one. It was `owner:` before 2026-09-21.

## Two things that are easy to get wrong

> [!important] Discord only sets the role when it actually knows something
> `upsertUser` originally rewrote the role from Discord on **every** login. With no guild
> configured `resolveRole` can only answer `guest` — so anyone promoted by hand, which is how
> the first admin has to be created, was silently demoted on their next sign-in.
> The role is now only overwritten when a guild was readable, or for the bootstrap admin —
> and never at all when `role_locked = 1`, which is checked first. See [[#`role_locked`]].

> [!important] `DISCORD_GUILD_ID` is optional on purpose
> Requiring it meant a deployment with valid credentials still refused every sign-in — blocking
> the very login needed to configure anything else. Without it, everyone resolves to `guest`
> but `DISCORD_BOOTSTRAP_ADMIN_ID` still gets in.

## The password-prompt question, settled

Asked and re-diagnosed four times. **The OAuth request has never been the problem.** Traced
against production on 2026-08-18:

| Step | What we send |
|---|---|
| `/auth/login` | `prompt=none` |
| Discord answers `login_required` | 302 → `/auth/login?retry=1&next=…` |
| Retry | authorize with **no `prompt` key at all** |

Plus PKCE, `next` preserved across the retry, and `account_selection_required` handled. Compared
side by side with another Discord-auth site of Justin's that "worked", ours was the stricter of
the two. There was nothing to copy across.

> [!important] Discord shows a password form when the *browsing context* has no Discord session
> That is the whole mechanism, and nothing we send can conjure one. So the question is never
> "what are our OAuth parameters" — verify those once and move on — it is **"which browser is
> opening the page, and has Discord ever met it?"**
>
> A site open in Chrome inherits Chrome's Discord session and shows the approval screen. The
> same flow inside an installed app does not, because that context has its own cookie jar.

Three surfaces, three different jars:

- **A normal browser tab** — has whatever session that browser holds. Works, nothing to fix.
- **`/go` installed to the home screen** — `display: standalone`, so a redirect to `discord.com`
  leaves our scope and Android hands it to an in-app Custom Tab with its own jar. Fixed
  2026-08-18: `src/lib/auth/signin-surface.ts` sends sign-in out through an `intent://` URL to
  the default `https` handler, i.e. the browser the trainer actually uses. **No `package=`** —
  pinning Chrome would recreate the bug on a phone that defaults to Samsung Internet.
- **The Android app's WebView** — a jar Discord has *never* seen, so it was a password every
  single time. Solved separately by `MainActivity.startSignIn`, which uses a Custom Tab.
- **A Safari web app on the Mac** — its own jar too, but with one grace the others lack:
  **Safari copies the site's cookies into the web app at Add-to-Dock time** (WWDC23), so
  installing while signed in inherits the session. iOS has never done this — an iPhone
  home-screen install starts empty, still true on iOS 26. macOS web apps also keep OAuth
  redirects *in* the app by heuristic, with `window.open` as the guarantee.

### The floor beneath all of it, and the door around the floor — 2026-08-19

Every fix above routes sign-in toward a jar that already holds a Discord session. None of them
can help when **no jar on hand has one** — a fresh Safari on a Mac, an installed iPhone app.
There, `prompt=none` comes back `login_required` and Discord's next screen is the
email-and-password form.

That case now goes to **`/auth/device`** instead: Discord's RFC 8628 **device authorization
grant**, the flow console linking runs on. The page shows a short code and a link to
`discord.com/activate`; the member approves from any Discord that is already signed in —
usually the app one home-screen tap away — while the Worker polls
`POST /api/v10/oauth2/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
On approval it runs the same pipeline as every other door (`fetchUser → fetchGuildRoles →
resolveRole → upsertUser → createSession`), so it is an additional entrance, not a second
identity system. Codes come from `POST /api/v10/oauth2/device/authorize`; the `device_code`
lives in an HttpOnly cookie and never reaches the page.

Two routes in: the callback sends `login_required` there (`interactionTarget` in
`src/lib/auth/next.ts` — only that error; `consent_required` keeps the plain retry, because
the approval screen is the experience we *want*), and installed non-Android apps go straight
there from any sign-in link (`signin-surface.ts`), skipping a doomed round trip through an
empty jar.

> [!warning] The grant is real but not promised — and the gate has two locks
> The endpoints are documented under Discord's **Social SDK** rather than the core OAuth2
> docs, and opening them took two portal actions, established empirically on 2026-08-19
> because neither alone was enough:
>
> 1. **Public Client ON** (OAuth2 tab) — necessary but not sufficient; the device endpoint
>    kept answering `401 Invalid client id` (code 50023) to credentials the ordinary token
>    endpoint accepted.
> 2. **Social SDK enrollment** — the app sidebar's **Games → Social SDK → Getting Started**
>    form (it moved under *Games*; older docs say a top-level "Social SDK" section). Granted
>    self-serve as the limited tier: the app's public `flags` went 0 →
>    `1024 = SOCIAL_LAYER_INTEGRATION_LIMITED (1 << 10)`, readable by anyone at
>    `GET /api/v10/applications/{id}/rpc`. The endpoint opened the moment the flag landed.
>
> Verified same day, end to end on production: code minted through the Worker, approved from
> the phone's Discord app — no password form anywhere — session created, and the guild-role
> fetch succeeded, so `guilds.members.read` works under the limited tier. `/auth/device`
> still treats refusal as a state, not an error: if Discord ever re-gates the grant, the page
> says so and offers the ordinary browser sign-in, which is the pre-2026-08-19 behaviour.

> [!important] Public Client ON changed the token endpoint's requirements, not our requests
> A public client may redeem authorization codes with PKCE alone. Verified after flipping:
> the token endpoint accepts **both** shapes — secretless PKCE-only *and* our usual
> secret-plus-PKCE — so every existing flow kept working unchanged. Redirect URIs stay pinned
> byte-for-byte in the portal; PKCE S256 was already universal here.

> [!danger] The Android redirect URI needs its single slash
> `Auth.kt` sends `discord-<app id>:/authorize/callback` — **one** slash after the colon, which
> is the shape Discord specifies for this flow. Discord matches redirect URIs byte for byte, and
> the string is repeated in both the authorize request and the token exchange. It looks like a
> typo and is not; deleting it in favour of a `://` version breaks app sign-in.

## Security properties

- Session tokens are random 256-bit values; **only their SHA-256 is stored**.
- Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`. Not `Strict` — the OAuth callback is a
  cross-site top-level navigation and Strict would drop the cookie on the way back.
- `next=` accepts same-origin paths only, so it cannot become an open redirect. On `/admin/login`
  the argument is stronger than on the callback: the value arrives from a form field the
  submitter controls entirely, and `safeNext` runs at the moment it becomes a `Location`.
- PKCE S256, verified against the RFC 7636 test vector in `scripts/test-auth.ts`.
- Sessions need no signing secret — tokens are random and hashed, so there is nothing to sign.
- Passwords are stored as PBKDF2-HMAC-SHA256 with a per-row salt and cost. `verifyPassword`
  **never throws**: a corrupt row answers `false`, because a 500 that happens for one username
  and not others is an oracle.
- `/api/auth/admin-login` accepts `application/x-www-form-urlencoded` and nothing else. Astro's origin
  check is content-type dependent and **skips `application/json` entirely** (see
  [[Platform Limits and Traps]]), so accepting JSON there would remove the only CSRF protection
  the route has. `/admin/login` carries no JavaScript at all, for the same reason and two others:
  it is reached when things are already broken, and a password that never touches app code
  cannot be logged by it.
- `/admin/login` carries `noindex, nofollow`. The page is publicly reachable by design and there
  is no `public/robots.txt`, so that tag is the only thing keeping it out of a search index —
  and keeping it out of a search index is *all* it does. The path itself is not a control; see
  [[#The admin password door]].
- The admin gate exempts `/admin/login` by **exact match**, `/admin/reset` by a second exact
  match, and `/admin/reset/<64 hex>` by shape. Nothing else under `/admin`. `/admin/login/`,
  `/admin/logins`, `/admin/reset/`, `/admin/resets`, `/admin/reset-notes` and anything nested
  below a token all still redirect a signed-out visitor to Discord sign-in, which is what
  makes each exemption one page wide rather than a section.
- Reset tokens are random 256-bit values; **only their SHA-256 is stored**, the same scheme
  as sessions. They expire in 30 minutes, work once, and a newer one kills the older.
- Both reset pages send `Referrer-Policy: strict-origin`, because the token is in the URL and a
  `Referer` would carry it off-site on one click. **Not `no-referrer`**: a form inherits its
  page's policy, `no-referrer` makes it post `Origin: null`, and Astro's CSRF check answers that
  with a 403. The redirects in the flow keep `no-referrer`, which no page inherits.
- Account deletion drops the password credential, clears `role_locked`, **and revokes
  outstanding reset links**. All three have to be explicit: `deleteAccount` anonymises by
  `UPDATE` and never `DELETE`s the `users` row, so `ON DELETE CASCADE` never fires for any of
  them. The link revocation sits outside the batch so a database still missing `0005` cannot
  turn a schema that is merely behind into a deletion that fails.

## Tests

Both layers, and they cover different halves of this. See [[Local Development]].

`npm test` covers the decisions that are pure functions: role resolution, the bootstrap
override, the optional member-role gate, the role hierarchy, PKCE and the `safeNext` guard —
68 checks in `scripts/test-auth.ts` — plus the installed-app sign-in handoff in
`scripts/test-signin-surface.ts`, the device grant's bodies, response mapping, cookie
payload and `login_required` routing split in `scripts/test-device-grant.ts`, and the password
primitives, the lockout schedule and the reset address validator in
`scripts/test-admin-password.ts`. That last one is asserted under `tsx` on purpose, for the
same reason the PBKDF2 vector is: the setter writes the address in Node and the route looks it
up inside workerd, and only the same function passing in both runtimes makes "what was written
is what will be found" a fact.

`npm run test:worker` covers the parts that only exist as a request crossing a boundary, which
is most of this note: `test/auth/` drives `/auth/login`, `/auth/callback`, logout, the device
grant, the Android exchange, the state cookie, the admin password door and `src/middleware.ts`
itself through `SELF.fetch`, with Discord mocked and sessions minted by the real
`createSession`. `admin-login.test.ts` asserts the same known-answer vector the tsx suite does,
which is the only thing that really proves the setter script and the Worker derive the same
bytes; it also pins the byte-identical refusals and `role_locked` **with its control**.
`admin-reset.test.ts` drives the reset end to end by reading the link out of a stubbed
Resend call — the only supported way to get a token, and therefore the only test that proves
the link the route composes is the link that works. It has to configure the mail sender to do
that, which it does for one test at a time and restores afterwards; the default, unconfigured
state is asserted separately, and nothing reaches the network at any point. The
authorisation gate in front of `/admin` is asserted as a full route × method × caller matrix in
`test/admin/`, and then a second time with the middleware removed, so a handler that defends
itself is distinguishable from one that only looks defended.

`scripts/preflight-device-grant.ts` re-checks whether Discord's device endpoint accepts the
app, shape-only, no secrets printed. It is not in either chain — it talks to Discord.

## See also

[[Configuration]] · [[Platform Limits and Traps]] · [[Why Discord is the identity provider]]
