---
tags: [decision]
updated: 2026-08-05
---

# Why Astro on Cloudflare Workers

**Decision:** Astro 7 (SSR) with React islands, deployed as a single Cloudflare Worker.

## Why Cloudflare

Already where the owner's other projects live, so no new account, billing or mental model. The
whole stack — compute, database, object storage, cache, realtime — is one platform with one
config file, and the free tier covers a community this size comfortably.

## Why Astro over React Router / SvelteKit

Most of this site is content: a map, a blog, event pages, legal pages. Astro ships **zero
JavaScript** for those and lets the genuinely interactive parts be islands. The blog and
gallery are static-fast; only `MapView`, `QuickActions`, `LiveBoard` and the admin editors
carry a bundle.

A full-stack React framework would have been a simpler single mental model, and that is a real
argument. But it pays JavaScript on every page for interactivity that only four pages need.

## Consequences

- Two idioms to hold: `.astro` for pages, `.tsx` for islands
- The adapter's virtual worker entry made the Durable Object binding awkward — see
  [[Flares and Realtime]]
- `Astro.locals.runtime.env` removal in v6 is a live footgun — see [[Platform Limits and Traps]]

## See also

[[Architecture Overview]]
