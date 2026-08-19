---
tags: [architecture, security]
updated: 2026-08-18
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

> [!warning] iOS cannot be fixed
> A standalone PWA on iOS gets its own cookie storage, there is no intent scheme, and Safari
> will not hand a page to another browser. An iPhone home-screen install pays one Discord login
> and there is no version of this that avoids it.

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
handoff in `scripts/test-signin-surface.ts`.

## See also

[[Configuration]] · [[Platform Limits and Traps]] · [[Why Discord is the identity provider]]
