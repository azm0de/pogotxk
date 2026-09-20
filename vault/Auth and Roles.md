---
tags: [architecture, security]
updated: 2026-09-19
---

# Auth and Roles

Discord is the sign-in method for everyone. The community already lives there, so guild
membership *is* the membership check — see [[Why Discord is the identity provider]].

There is one other door, and it is not for members: the owner's password at `/auth/owner`.
See [[#The second door]].

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

## The second door

`/auth/owner` is a password login for one account. Nothing links to it, no member ever sees it,
and it exists for the day Discord sign-in cannot produce an admin.

> [!danger] Why it had to exist
> `DISCORD_GUILD_ID` is set and the `DISCORD_ROLE_*` ids are not. So `resolveRole` falls
> through to `member` for every guild member — and because a guild *is* configured, Discord is
> **authoritative**, so `upsertUser` writes that answer. A hand-promoted admin is therefore
> demoted by their own next sign-in.
>
> That leaves exactly one path to `admin`: `DISCORD_BOOTSTRAP_ADMIN_ID`, a secret that
> short-circuits `resolveRole` for one Discord account. One account, one secret, one
> third-party service, and no recovery if any of the three is lost. Setting the
> `DISCORD_ROLE_*` ids would fix the demotion but not the single point of failure — it would
> just move it into the Discord server's role configuration.

**How it works.** The password proves *which existing `users` row you are*, and everything after
that is the code every other door already runs: `createSession`, the same `sessions` table, the
same `pogotxk_session` cookie. It is an additional entrance, not a second identity system —
the same claim `/auth/device` makes.

- The credential lives in `admin_credentials`, keyed `user_id` — see [[Data Model]].
- PBKDF2-HMAC-SHA256, 16-byte salt, 32-byte output, unpadded base64url. The iteration count is
  stored **in the row**, so it can be raised without invalidating the hash: verification uses
  the count it finds, and a successful login re-derives at the current one.
- `src/lib/auth/password.ts` carries no `cloudflare:workers` import and no `~/` alias, so
  `scripts/set-admin-password.ts` imports the very same module under plain `tsx`. The RFC
  known-answer vector is asserted in *both* test layers, which is what actually proves the
  hash written from Node verifies inside workerd.

> [!warning] The iteration count does not currently fit the free plan
> Measured inside workerd on 2026-09-19: PBKDF2 here is linear at **0.53 ms per 1,000
> iterations**, so `DEFAULT_ITERATIONS = 100_000` costs about **53 ms of CPU**. A Worker on the
> free plan gets **10 ms per invocation** and `wrangler.jsonc` sets no `limits` block, so the
> plan default applies. A sign-in at 100k would be killed mid-derivation.
>
> Left as a decision rather than quietly lowered. Workers Paid ($5/month) raises the default
> budget to 30 s, where OWASP's 600,000 fits comfortably; staying free means dropping to the
> schema floor of 10,000 (~5 ms) and leaning on the setter script's 16-character minimum and
> the lockout instead. The full numbers are in the comment above `DEFAULT_ITERATIONS`.

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
> role, so banning stays the emergency off-switch even against a locked owner. A flag that also
> defeated a ban would be a permanent un-revocable admin — a second copy of the single point of
> failure this feature exists to remove.

### Lockout

Five wrong passwords shut the door. The schedule escalates and is **capped at one hour**:
1 minute, then 5, then 30, then 60 and no further.

The cap is the design, not a rounding-off. The person locked out is the site owner, and this is
the door for the day the other one is already broken; an unbounded schedule would be a denial
of service aimed at the one human who cannot route around it, triggerable by anyone who knows
the username.

- The counter **decays on the next attempt**, not on a sweep — a failure whose predecessor is
  older than 24 hours starts again at 1. There is no cron here ([[Why there is no cron]]), so
  this is the same shape the announcement and flare sweeps take.
- The increment is a single SQL statement with the decay rule inside it, so two simultaneous
  attempts cannot both read 4 and both write 5.
- **A correct password while locked is still refused**, and `failed_attempts` is left alone.
- The locked path does **not** hash. The response says "locked" out loud on purpose — the owner
  has to be able to tell a wrong password from a wait — so spending a full PBKDF2 to hide a
  fact the message already states would only hand an attacker a way to burn the CPU budget.

### What it refuses to say

A wrong password, an unknown username, a username with no credential, and a row too corrupt to
check are all the same answer: `303` to `/auth/owner?error=bad`, byte for byte. An unknown
username burns a real derivation first so the timing matches — measured at 56 ms against the
wrong-password path's 60 ms, the 4 ms being two D1 writes.

The audit log records failures with **no username and no password**, because one day the owner
will type their password into the username field and `audit_log` is readable by every
ambassador. A failure against an unknown username is not logged at all: it has no counter to
bound it, so logging it would let anyone append to `audit_log` at will.

### Setting the password

```bash
npm run set:password -- --discord-id <snowflake>   # an existing users row
npm run set:password -- --create <name>            # genuine break-glass
```

> [!danger] It must be run from a real console, and it refuses otherwise
> Under Git Bash / mintty, `node` is handed a pipe rather than a console: `stdin.isTTY` is
> `undefined`, readline's private `_writeToOutput` override silently does nothing, and **the
> password echoes in plain text** while looking like it worked. Echo cannot be suppressed on a
> pipe, so the script stops rather than guessing. Use PowerShell or Windows Terminal, or
> prefix with `winpty`.

The password is never a CLI argument, never piped, never displayed — the same standing rule
that produced the VAPID procedure in [[Configuration]]. It is prompted twice and compared,
because a typo'd password is a lockout nobody discovers until Discord is already broken, and
the minimum is 16 characters.

`--discord-id` refuses a snowflake with no `users` row rather than inventing one: a row keyed to
a made-up id means the next real sign-in inserts a *second* row for the same person, because
`upsertUser` matches on `discord_id`. `--create` mints a deliberately **non-numeric** synthetic
id (`owner:<name>`) that can never collide with a real snowflake — the same property
`anonymizedIdentity` relies on for `deleted:<id>`.

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
- `next=` accepts same-origin paths only, so it cannot become an open redirect. On `/auth/owner`
  the argument is stronger than on the callback: the value arrives from a form field the
  submitter controls entirely, and `safeNext` runs at the moment it becomes a `Location`.
- PKCE S256, verified against the RFC 7636 test vector in `scripts/test-auth.ts`.
- Sessions need no signing secret — tokens are random and hashed, so there is nothing to sign.
- Passwords are stored as PBKDF2-HMAC-SHA256 with a per-row salt and cost. `verifyPassword`
  **never throws**: a corrupt row answers `false`, because a 500 that happens for one username
  and not others is an oracle.
- `/api/auth/owner` accepts `application/x-www-form-urlencoded` and nothing else. Astro's origin
  check is content-type dependent and **skips `application/json` entirely** (see
  [[Platform Limits and Traps]]), so accepting JSON there would remove the only CSRF protection
  the route has. `/auth/owner` carries no JavaScript at all, for the same reason and two others:
  it is reached when things are already broken, and a password that never touches app code
  cannot be logged by it.
- `/auth/owner` carries `noindex, nofollow`. The page is publicly reachable by design and there
  is no `public/robots.txt`, so that tag is the only thing keeping it out of a search index.
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
primitives and lockout schedule in `scripts/test-owner-password.ts`.

`npm run test:worker` covers the parts that only exist as a request crossing a boundary, which
is most of this note: `test/auth/` drives `/auth/login`, `/auth/callback`, logout, the device
grant, the Android exchange, the state cookie, the owner password door and `src/middleware.ts`
itself through `SELF.fetch`, with Discord mocked and sessions minted by the real
`createSession`. `owner-login.test.ts` asserts the same known-answer vector the tsx suite does,
which is the only thing that really proves the setter script and the Worker derive the same
bytes; it also pins the byte-identical refusals and `role_locked` **with its control**. The
authorisation gate in front of `/admin` is asserted as a full route × method × caller matrix in
`test/admin/`, and then a second time with the middleware removed, so a handler that defends
itself is distinguishable from one that only looks defended.

`scripts/preflight-device-grant.ts` re-checks whether Discord's device endpoint accepts the
app, shape-only, no secrets printed. It is not in either chain — it talks to Discord.

## See also

[[Configuration]] · [[Platform Limits and Traps]] · [[Why Discord is the identity provider]]
