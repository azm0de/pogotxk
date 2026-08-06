---
tags: [architecture, feature]
updated: 2026-08-05
---

# Flares and Realtime

A **flare** is a short-lived broadcast: "raid starting at this gym, come join". It is the
feature the whole project was originally asked for.

## Kinds and lifetimes

| Kind | Default TTL | Why that number |
|---|---|---|
| `raid` | 45 min | An egg plus the battle window |
| `gym_takedown` | 30 min | |
| `meetup_here` | 120 min | |
| `remote_invites` | 20 min | Goes stale the moment the lobby fills |
| `trade` | 120 min | Can sit for an afternoon |
| `help` | 60 min | |

TTLs track how long the underlying thing is actually useful for. That is what keeps the board
honest without anyone remembering to close their own flare — expiry is computed on read, so no
cron is needed. See [[Why there is no cron]].

## Fan-out

A flare reaches people three ways, all inside `waitUntil` so none of them can delay the
response for someone standing at a gym:

```
POST /api/flares
   │
   ├─▶ D1                    source of truth
   ├─▶ Durable Object        WebSocket push to open clients
   ├─▶ Discord webhook       rich embed, message id stored so it can be struck through later
   └─▶ Web Push              members who opted in, author excluded
```

See [[Notifications]] for the last two.

## The Durable Object

`src/do/LiveBoard.ts`. Uses the **WebSocket Hibernation API** (`acceptWebSocket`,
`webSocketMessage`, `webSocketClose`) rather than `addEventListener` — hibernation is what keeps
an idle board inside the free tier.

D1 stays the source of truth; the DO holds only ephemeral connection state. A cold or evicted
object therefore cannot disagree with the database.

> [!warning] Wiring the binding is not obvious
> Cloudflare resolves a Durable Object binding by looking for a **named export** on the deployed
> script, and a binding naming a class the entry does not export fails the deploy outright. The
> Astro adapter builds its entry from a virtual module that only exports `default`, with no
> option to add to it. A Vite plugin in `astro.config.mjs` appends the export:
>
> ```js
> transform(code, id) {
>   if (!id.includes('virtual:cloudflare/worker-entry')) return null
>   return { code: `${code}\nexport { LiveBoard } from ...` }
> }
> ```
>
> If a future adapter moves that seam the build still succeeds and the deploy fails loudly on
> the missing class — which is the right failure mode.

## Where flares surface

- `/live` — the board
- `/go` — quick actions, with join buttons
- `/map` — the gym pulses, sorts above its neighbours, and its popup leads with a red banner
- Android bubble — see [[Android App]]

The map uses a WebSocket **plus** a 60-second poll. The poll is not redundant: it is what makes
expiry show up, since nothing broadcasts when a flare simply runs out of time.

## See also

[[Notifications]] · [[Android App]] · [[Bugs Worth Remembering]]
