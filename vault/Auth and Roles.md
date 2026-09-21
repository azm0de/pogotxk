---
tags: [architecture, security]
updated: 2026-09-21
---

# Auth and Roles

Discord is the sign-in method for everyone. The community already lives there, so guild
membership *is* the membership check — see [[Why Discord is the identity provider]].

There is one other door, and it is not for members: the admin password at `/admin/login`.
The accounts behind it are standalone identities with no Discord account of their own — see
[[#The admin password door]].

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

### Setting the password

```bash
npm run set:password -- --discord-id <snowflake>   # an existing users row
npm run set:password -- --create <name>            # a standalone admin identity
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
because a typo'd password is a permanent lockout — there is no reset link, no recovery email
and, for a standalone identity, no Discord sign-in to fall back on. The minimum is 16
characters.

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
- The admin gate exempts `/admin/login` by **exact match** and nothing else under `/admin`.
  `/admin/login/`, `/admin/login/extra`, `/admin/logins` and `/admin/login-notes` all still
  redirect a signed-out visitor to Discord sign-in, which is what makes the exemption one page
  wide rather than a section.
- Account deletion drops the password credential and clears `role_locked`. It has to be
  explicit: `deleteAccount` anonymises by `UPDATE` and never `DELETE`s the `users` row, so
  `admin_credentials`' `ON DELETE CASCADE` never fires.

## Tests

Both layers, and they cover different halves of this. See [[Local Development]].

`npm test` covers the decisions that are pure functions: role resolution, the bootstrap
override, the optional member-role gate, the role hierarchy, PKCE and the `safeNext` guard —
68 checks in `scripts/test-auth.ts` — plus the installed-app sign-in handoff in
`scripts/test-signin-surface.ts`, the device grant's bodies, response mapping, cookie
payload and `login_required` routing split in `scripts/test-device-grant.ts`, and the password
primitives and lockout schedule in `scripts/test-admin-password.ts`.

`npm run test:worker` covers the parts that only exist as a request crossing a boundary, which
is most of this note: `test/auth/` drives `/auth/login`, `/auth/callback`, logout, the device
grant, the Android exchange, the state cookie, the admin password door and `src/middleware.ts`
itself through `SELF.fetch`, with Discord mocked and sessions minted by the real
`createSession`. `admin-login.test.ts` asserts the same known-answer vector the tsx suite does,
which is the only thing that really proves the setter script and the Worker derive the same
bytes; it also pins the byte-identical refusals and `role_locked` **with its control**. The
authorisation gate in front of `/admin` is asserted as a full route × method × caller matrix in
`test/admin/`, and then a second time with the middleware removed, so a handler that defends
itself is distinguishable from one that only looks defended.

`scripts/preflight-device-grant.ts` re-checks whether Discord's device endpoint accepts the
app, shape-only, no secrets printed. It is not in either chain — it talks to Discord.

## See also

[[Configuration]] · [[Platform Limits and Traps]] · [[Why Discord is the identity provider]]
