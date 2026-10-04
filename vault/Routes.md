---
tags: [reference]
updated: 2026-10-04
---

# Routes

## Public

| Route | What |
|---|---|
| `/` | Home — Campsite intro, live counts, next meetup, photos, socials |
| `/map` | The map. `?poi=<slug>` deep-links to one pin |
| `/go` | Quick actions. The installable PWA start URL |
| `/live` | Flare board |
| `/events` | Community meetups + global calendar, Live Now / Upcoming / Past. No subscribable feed — see [[Backlog]] |
| `/raids` `/eggs` `/research` | Auto from Leek Duck |
| `/blog` `/blog/[slug]` | News |
| `/gallery` | Community photos with credits |
| `/about` `/conduct` `/terms` `/privacy` | Static |
| `/offline` | Service worker fallback |
| `/rss.xml` | Feed |
| `/account/delete` | Self-service account deletion (the page Google Play's data-deletion rule points at). Works from a plain browser: signed out, it offers Discord sign-in and returns here |
| `/media/[...key]` | Objects from R2 (photos), immutable cache. A page-level route that happens to serve bytes, not part of the JSON API |

## Auth

| Route | What |
|---|---|
| `/auth/login` | Starts Discord OAuth. Renders a config diagnostic when unconfigured |
| `/auth/callback` | Completes it |
| `/auth/device` | RFC 8628 approval, for a browser whose jar holds no Discord session |
| `/auth/logout` | Ends the session. A POST form button since the admin audit (2026-10); a plain GET still works from our own pages but a cross-site link can no longer sign someone out |
| `/auth/error` | Human-readable failure |
| `/admin/login` | The admin password form — username **or** recovery email, and a password. Where the `/admin` gate sends every page request it refuses. Public despite the path — see below and [[Auth and Roles#The admin password door]] |
| `/admin/reset` | Asks for a password-reset link. Public despite the path, same as above |
| `/admin/reset/<token>` | Sets the new password. `Referrer-Policy: strict-origin` — the token is in the URL, and `no-referrer` would null the form's `Origin` |

## Admin — `ambassador` or better

| Route | What |
|---|---|
| `/admin` | Dashboard, plus the legacy import panel (admin only) |
| `/admin/map` | Map editor — click to place, drag to move, upload photos |
| `/admin/meetups` | Meetup editor |
| `/admin/posts` | Blog editor |
| `/admin/media` | Media library — browse R2, fix alt text and photo credits |

Below `ambassador`, a page here answers `302 /admin/login?next=<path>` — the admin form, not
Discord's `/auth/login` (changed 2026-09-23: Discord can no longer produce anyone the gate
admits). The API routes under `/api/admin/` answer JSON instead: 401 signed out, 403 signed in.

> [!important] Three paths under this prefix are **not** gated
> `/admin/login`, `/admin/reset` and `/admin/reset/<token>`. All three are listed under Auth
> above, because that is what they are. The first is where the gate sends everyone it refuses,
> so a gate in front of it would redirect it to itself; the reset pair exists precisely for
> somebody who cannot get through the first one.
>
> The gate exempts the first two by **exact string match** and the third by the **shape of a
> token** — one segment of 64 lowercase hex characters, which is what `randomToken()`
> produces. `/admin/login/`, `/admin/logins`, `/admin/reset/`, `/admin/resets`,
> `/admin/reset-notes`, an uppercase token and anything nested below a token all still
> redirect a signed-out visitor.
>
> None of the paths is a secret, because the repo is public. The password and the lockout are
> the controls on the first; the token's entropy, its half-hour expiry and its single use are
> the controls on the others. All three are unlinked (apart from `/admin/login` linking to
> `/admin/reset`, which is the only way anyone would find it), carry `noindex`, and are
> deliberately absent from `Admin.astro`'s nav, which is for signed-in admins.

## API

| Endpoint | Auth | What |
|---|---|---|
| `GET /api/map.json` | public | Zone, POIs, shapes, community photos |
| `GET /api/me.json` | public | Current session or null, plus two booleans for the account menu: `canAdmin` (the `/admin` gate's own check, `canReachAdmin`) and `standaloneAdmin` (a password-only `admin:<name>` identity). `private, no-store` |
| `GET /api/game/[feed].json` | public | `raids` \| `eggs` \| `research` \| `events` |
| `GET /api/flares` | public | Active flares |
| `POST /api/auth/admin-login` | public | The admin password login, by username or recovery address (`@` picks the column). Form encoding only, 415 otherwise; every answer is a 303 |
| `POST /api/auth/admin-reset` | public | Asks for a reset link. Form encoding only, 415 otherwise. **Identical answer whether or not the address is registered** |
| `POST /api/auth/admin-reset/confirm` | public | Redeems a link and sets the password. Form encoding only; ends at the sign-in form, never at a session |
| `POST /api/auth/device/start` | public | Begins a device-grant sign-in: asks Discord for a code, parks the polling credential in an HttpOnly cookie |
| `POST /api/auth/device/poll` | public (cookie) | One poll of that sign-in; on approval it creates the session |
| `POST /api/auth/mobile` | public | Finishes a sign-in that began in the Android app: the app posts the authorization code and PKCE verifier, and gets a session cookie back |
| `DELETE /api/account` | signed in | Deletes the caller's own account (anonymised in place, not removed). Standalone `admin:` identities are refused |
| `POST /api/flares` | member | Fire one |
| `PATCH /api/flares/[id]` | member | RSVP or close |
| `GET /api/flares/socket` | public | WebSocket upgrade → Durable Object |
| `GET/POST/DELETE /api/push/subscribe` | mixed | VAPID key / manage subscription |
| `/api/admin/pois` `/meetups` `/posts` | ambassador | List, create, edit. Delete **archives by default**: POIs, posts (`archived`) and meetups (`cancelled`) are kept as rows. Permanent delete is **admin only**, asked for with `?hard=1` (POIs have always worked this way; posts and meetups were brought in line by the 2026-10 admin audit) |
| `GET/POST /api/admin/media` | ambassador | List, upload. There is no media DELETE route yet — see [[Backlog]] |
| `PATCH /api/admin/media/[id]` | ambassador | Attribution fields only |
| `GET /img/leekduck/[...path]` | public | Cached proxy for Leek Duck event artwork |
| `GET /img/discord/[...path]` | public | Cached proxy for Discord scheduled-event cover art, allowlisted to `guild-events/…` on Discord's CDN |
| `POST /api/admin/import-legacy` `/import-media` | admin **or** token | [[Importing Legacy Data]]. A non-browser caller needs an `Origin` header or a JSON content type. `import-legacy` refuses a populated database (409); there is no `?force` |
| `GET /api/admin/config-check` | **admin session only** | Which variables the Worker can see. The import token is not accepted here; an ambassador gets 403 "Requires admin" |

## See also

[[Architecture Overview]] · [[Auth and Roles]]
