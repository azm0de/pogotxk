---
tags: [index]
updated: 2026-08-05
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

Everything in the original plan is built and deployed.

- [x] Map with all 104 locations, both overlays, 63 photos
- [x] Admin console — map editor, meetups, posts, one-click import
- [x] Discord sign-in with role mapping
- [x] Blog, RSS, events, subscribable calendar feeds
- [x] Auto-updating raid bosses / eggs / research
- [x] Realtime flare board over a Durable Object
- [x] Installable web app at `/go`
- [x] Android floating bubble
- [ ] Push + Discord fan-out — code done, **needs secrets**, see [[Configuration]]
- [ ] Bubble tested on real hardware — see [[Android App]]
