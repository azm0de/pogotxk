---
tags: [reference]
updated: 2026-09-20
---

# Platform Limits and Traps

Things that cost time, or would have. Each is a real constraint of the platform rather than a
bug in this codebase.

## Cloudflare

**Plain-text vars are wiped on deploy.** `wrangler deploy` deletes every var not in
`wrangler.jsonc`. Secrets are exempt. See [[Configuration]].

**A Worker cannot usefully fetch its own hostname.** It is a loopback through the edge. It
resolves fine against `astro dev` and returns nothing in production — so a page fetching its own
API route works locally and is silently empty live. Call the data layer directly.

**50 subrequests per invocation** on the free plan. Any fan-out over more than ~45 external
requests must be chunked — see [[Importing Legacy Data]].

**10 ms of CPU per invocation** on the free plan, which is the default when `wrangler.jsonc`
declares no `limits` block. It is CPU, not wall clock, so waiting on D1 or `fetch` costs
nothing and pure computation costs everything — and `waitUntil` does **not** escape it: the
work is deferred past the response but billed to the same request. Measured here on
2026-09-19, PBKDF2-HMAC-SHA256 inside workerd runs at **0.53 ms per 1,000 iterations**, so
100,000 rounds is ~53 ms and does not fit — which is why `DEFAULT_ITERATIONS` is 10,000 (~5 ms),
the schema's floor. Workers Paid raises the default to 30 s. See
[[Auth and Roles#The admin password door]].

**10 D1 databases** on the free plan. Hit at project start.

**Durable Object bindings require a named export** on the deployed script, and the Astro adapter
does not provide one. See [[Flares and Realtime]].

**Versioned preview URLs are frozen.** A hostname with a hex prefix serves one specific version
forever. See [[Deploying]].

## Astro 7

**`Astro.locals.runtime.env` was removed in v6** and now throws. Use
`import { env } from 'cloudflare:workers'`. `Astro.locals.cfContext` carries the
ExecutionContext; request metadata is on `Astro.request.cf`.

**Cross-site POSTs are blocked**, but only for *form-like* content types — and that is the
opposite way round from how it is usually remembered. Read
`node_modules/astro/dist/core/app/origin-check.js`: it compares `Origin` against the request
URL when the content type is `x-www-form-urlencoded`, `multipart/form-data` or `text/plain`,
**and when there is no content type at all**. `application/json` skips the check entirely.

So sending JSON is what makes a cross-site POST *possible*, not what makes it safe. For
ordinary `fetch` callers that is a convenience; for anything that accepts credentials it is a
hole, which is why `/api/auth/admin-login` accepts form encoding only and answers 415 to JSON.

**`<slot name="head" />` must exist** or a page's `<Fragment slot="head">` is silently discarded
— invisible in a browser, only showing up as missing metadata in a scraper.

**Prerendered pages 307 to a trailing slash.**

## TypeScript in a Workers project

**The Workers runtime types declare their own `interface Element`** — HTMLRewriter's — which
merges with the DOM `Element`. Its directly-declared `append` shadows the inherited
`ParentNode.append`, so `parent.append(...)` fails to typecheck in client code. `appendChild` is
unaffected. `src/components/map/MapView.tsx` has an `add()` helper for this.

## Browsers

**`Cache.put()` rejects redirected responses**, and `cache.add()` is fetch-then-put — so caching
a URL that 307s silently fails. Bit the offline page.

**`display: grid` on a class beats the UA's `[hidden] { display: none }`.** An element can
report `aria-expanded="false"` while remaining fully visible.

**iOS requires a real user gesture** for `Notification.requestPermission()`, and reports nothing
when it refuses.

## Discord

**`prompt=none` is non-strict** — it falls back to showing consent for first-time users rather
than erroring, unlike a strict OIDC provider. Verified before relying on it.

**Scopes are per-request**, not registered in the portal. The OAuth2 URL Generator is only a link
builder. The **only** thing that must be configured there is the redirect URI.

## Android

**No iOS equivalent exists** for a floating overlay. See
[[Why iOS cannot have a floating bubble]].

**A drag handler needs a movement threshold** or every tap registers as a drag, because a thumb
always slides a few pixels.

**AGP does not support Java 24.** Build with JDK 17–21.

## See also

[[Bugs Worth Remembering]] · [[Configuration]] · [[Deploying]]
