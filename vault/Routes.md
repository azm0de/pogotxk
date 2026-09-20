---
tags: [reference]
updated: 2026-09-19
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
| `/auth/owner` | The owner's password form. Unlinked, `noindex`, no JavaScript — see [[Auth and Roles#The second door]] |

## Admin — `ambassador` or better

| Route | What |
|---|---|
| `/admin` | Dashboard, plus the legacy import panel (admin only) |
| `/admin/map` | Map editor — click to place, drag to move, upload photos |
| `/admin/meetups` | Meetup editor |
| `/admin/posts` | Blog editor |
| `/admin/media` | Media library — browse R2, fix alt text and photo credits |

## API

| Endpoint | Auth | What |
|---|---|---|
| `GET /api/map.json` | public | Zone, POIs, shapes, community photos |
| `GET /api/me.json` | public | Current session or null |
| `GET /api/game/[feed].json` | public | `raids` \| `eggs` \| `research` \| `events` |
| `GET /api/flares` | public | Active flares |
| `POST /api/auth/owner` | public | The owner password login. Form encoding only, 415 otherwise; every answer is a 303 |
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
