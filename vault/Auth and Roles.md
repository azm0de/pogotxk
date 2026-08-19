---
tags: [architecture, security]
updated: 2026-08-19
---

# Auth and Roles

Discord is the only sign-in method. The community already lives there, so guild membership
*is* the membership check — see [[Why Discord is the identity provider]].

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
| `admin` | Has the admin role, or is `DISCORD_BOOTSTRAP_ADMIN_ID` | Also: hard delete, import, settings |

## Two things that are easy to get wrong

> [!important] Discord only sets the role when it actually knows something
> `upsertUser` originally rewrote the role from Discord on **every** login. With no guild
> configured `resolveRole` can only answer `guest` — so anyone promoted by hand, which is how
> the first admin has to be created, was silently demoted on their next sign-in.
> The role is now only overwritten when a guild was readable, or for the bootstrap admin.

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
- `next=` accepts same-origin paths only, so it cannot become an open redirect.
- PKCE S256, verified against the RFC 7636 test vector in `scripts/test-auth.ts`.
- Sessions need no signing secret — tokens are random and hashed, so there is nothing to sign.

## Tests

`npm test` covers role resolution, the bootstrap override, the optional member-role gate, the
role hierarchy, and PKCE. 23 checks in `scripts/test-auth.ts`, plus the installed-app sign-in
handoff in `scripts/test-signin-surface.ts` and the device grant — bodies, response mapping,
cookie payload, and the `login_required` routing split — in `scripts/test-device-grant.ts`.
`scripts/preflight-device-grant.ts` re-checks whether Discord's device endpoint accepts the
app, shape-only, no secrets printed.

## See also

[[Configuration]] · [[Platform Limits and Traps]] · [[Why Discord is the identity provider]]
