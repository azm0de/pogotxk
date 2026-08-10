---
tags: [index]
updated: 2026-08-10
---

# PoGo TXK

Community platform for the Pokémon GO community in Texarkana, Texas and Arkansas.
Replaces the hand-maintained static site at [pokemontxk.com](https://pokemontxk.com).

**Live:** https://pogotxk.gnomelabz.workers.dev
**Repo:** https://github.com/azm0de/pogotxk

> [!warning] The URL trap
> `ec3b35ec-pogotxk.gnomelabz.workers.dev` is a **per-version preview URL**, frozen at
> whichever version it was minted from. It never updates. The production URL has no hex
> prefix. This cost an hour of misdiagnosing "the deploy is broken" — see
> [[Platform Limits and Traps]].

## Start here

- [[Architecture Overview]] — what runs where
- [[Configuration]] — every secret and variable, and which are still unset
- [[Backlog]] — what is left

## By area

| Area | Notes |
|---|---|
| Structure | [[Architecture Overview]] · [[Data Model]] · [[Routes]] |
| Look | [[Design System]] |
| Behaviour | [[Auth and Roles]] · [[Flares and Realtime]] · [[Notifications]] |
| Operating it | [[Local Development]] · [[Deploying]] · [[Configuration]] · [[Importing Legacy Data]] |
| Android | [[Android App]] |
| Obligations | [[Attribution Obligations]] · [[Never Touch the Game]] |
| History | [[Migration from the Old Site]] · [[Bugs Worth Remembering]] |

## Decisions

- [[Why Astro on Cloudflare Workers]]
- [[Why Discord is the identity provider]]
- [[Why iOS cannot have a floating bubble]]
- [[Why there is no cron]]
- [[Never Touch the Game]]

## Status

Everything in the original plan is built and deployed, and every defect found so far is fixed.
Two of five production auditors never reported — see [[Backlog]].

- [x] Map with all 104 locations, both overlays, 63 photos
- [x] Admin console — map editor, meetups, posts, one-click import
- [x] Discord sign-in with role mapping
- [x] Blog, RSS, events, subscribable calendar feeds
- [x] Auto-updating raid bosses / eggs / research
- [x] Realtime flare board over a Durable Object
- [x] Installable web app at `/go`
- [x] Android floating bubble
- [x] 16 review defects fixed — see [[Bugs Worth Remembering]]
- [x] 3 more found by a production audit and fixed: an open redirect, six dead calendar
      subscribe links, and a role that survived leaving the Discord
- [x] Web push live; Discord fan-out still needs a webhook — see [[Backlog]]
- [x] A design pass over every page — see [[Backlog]] and [[Bugs Worth Remembering]]
- [x] Two design skills wired into the repo, and the 63 landmark photographs surfaced on the
      home page — see [[Design System]]
- [x] Repainted red and white as a Poké Ball, replacing the inherited navy and cream
- [x] The community's own GO Fest photograph as the home page banner
- [ ] Bubble tested on real hardware — see [[Android App]]

Shipped 2026-08-10, in one push: the Poké Ball repaint, a generated **PoGo TXK logo** now serving
as the wordmark in the hero and the header, social marks beside the brand, a Poké Ball nav menu on
phones, the **Leafeon and Espeon forest video** behind the hero, the community photograph moved
into its own section, clickable event cards linking back to Leek Duck, and Poké Ball favicon and
app icons. See [[Design System]].

Production runs whatever is on `main`; a push deploys in 60–90 seconds. `npm test` is 9 suites.
