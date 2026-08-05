# PoGo TXK

Community platform for **PoGo Texarkana** — the Pokémon GO community serving Texarkana, TX/AR.

Replaces the hand-maintained static site at [pokemontxk.com](https://pokemontxk.com) with a
database-backed application: admin console, editable map, blog, live event data, and a mobile
quick-action surface for firing flares while you play.

## Stack

Astro 7 (SSR) + React islands on **Cloudflare Workers**.

| Binding | Product | Holds |
|---|---|---|
| `DB` | D1 (`pogotxk-db`) | POIs, posts, meetups, users, flares, settings |
| `MEDIA` | R2 (`pogotxk-media`) | Photo originals, KMZ uploads, PDFs |
| `CACHE` | KV (`pogotxk-cache`) | ScrapedDuck payloads, cached settings |
| `LIVE` | Durable Object | Live board — flares + presence over WebSocket |

Cron `*/30 * * * *` refreshes the ScrapedDuck feed into KV.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in the values
npm run db:migrate:local
npm run dev
```

`npm run dev` serves on <http://localhost:4321> with local D1/R2/KV via Miniflare — no
Cloudflare account needed, and nothing touches production data.

To exercise the real Workers runtime instead:

```bash
npm run build && npm run preview
```

## Deploying

Production deploys run through **Workers Builds** — push to `main` and Cloudflare builds and
deploys automatically. One-time setup in the dashboard:

1. **Workers & Pages → pogotxk → Settings → Build**
2. **Connect** the `azm0de/pogotxk` GitHub repo (authorizes the Cloudflare GitHub App)
3. Build command `npm run build`, deploy command `npx wrangler deploy`
4. Add the secrets from `.dev.vars.example` under **Settings → Variables and Secrets**

Manual deploy, if you need one: `npm run deploy`.

## Data sources and attribution

Live event, raid boss, egg, and research data comes from
[**ScrapedDuck**](https://github.com/bigfoott/ScrapedDuck), which scrapes
[**LeekDuck.com**](https://leekduck.com).

> Their terms require that any page using this data carries **no paywall and no advertising**,
> and visibly attributes **both ScrapedDuck and LeekDuck**. Keep it that way.

Map tiles are © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors and
© [CARTO](https://carto.com/attributions).

Community photos retain their original credit and source. The Texarkana Gazette press photo in
particular carries a byline and article link that must not be stripped.

## Not affiliated with Niantic

This site is a fan project and is not officially affiliated with Pokémon GO. Pokémon and its
trademarks are ©1995–2026 Nintendo, Creatures, and GAMEFREAK. All images and names owned and
trademarked by Nintendo, Niantic, The Pokémon Company, and GAMEFREAK are property of their
respective owners.

**The companion app never touches the game.** No screen capture, no accessibility-service
scraping, no process hooking, no GPS mocking, no Niantic or Campfire API access. It talks only
to this Worker and to our own Discord. That line is not negotiable — crossing it puts community
members' accounts at risk.
