---
tags: [reference]
updated: 2026-09-22
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

## Auth

| Route | What |
|---|---|
| `/auth/login` | Starts Discord OAuth. Renders a config diagnostic when unconfigured |
| `/auth/callback` | Completes it |
| `/auth/device` | RFC 8628 approval, for a browser whose jar holds no Discord session |
| `/auth/logout` | Ends the session |
| `/auth/error` | Human-readable failure |
| `/admin/login` | The admin password form. Public despite the path — see below and [[Auth and Roles#The admin password door]] |
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

> [!important] Three paths under this prefix are **not** gated
> `/admin/login`, `/admin/reset` and `/admin/reset/<token>`. All three are listed under Auth
> above, because that is what they are — the accounts behind them are standalone identities
> with no Discord sign-in, so a gate in front of any of them would send the only people they
> are for to a door that cannot admit them, and the reset pair exists precisely for somebody
> who cannot get through the first one.
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
| `GET /api/me.json` | public | Current session or null |
| `GET /api/game/[feed].json` | public | `raids` \| `eggs` \| `research` \| `events` |
| `GET /api/flares` | public | Active flares |
| `POST /api/auth/admin-login` | public | The admin password login. Form encoding only, 415 otherwise; every answer is a 303 |
| `POST /api/auth/admin-reset` | public | Asks for a reset link. Form encoding only, 415 otherwise. **Identical answer whether or not the address is registered** |
| `POST /api/auth/admin-reset/confirm` | public | Redeems a link and sets the password. Form encoding only; ends at the sign-in form, never at a session |
| `POST /api/flares` | member | Fire one |
| `PATCH /api/flares/[id]` | member | RSVP or close |
| `GET /api/flares/socket` | public | WebSocket upgrade → Durable Object |
| `GET/POST/DELETE /api/push/subscribe` | mixed | VAPID key / manage subscription |
| `/api/admin/pois` `/meetups` `/posts` `/media` | ambassador | CRUD |
| `PATCH /api/admin/media/[id]` | ambassador | Attribution fields only |
| `GET /img/leekduck/[...path]` | public | Cached proxy for Leek Duck event artwork |
| `POST /api/admin/import-legacy` `/import-media` | admin **or** token | [[Importing Legacy Data]] |
| `GET /api/admin/config-check` | admin **or** token | Which variables the Worker can see |
| `GET /media/[...key]` | public | R2 objects, immutable cache |

## See also

[[Architecture Overview]] · [[Auth and Roles]]
