/// <reference types="astro/client" />
/// <reference types="@astrojs/cloudflare/types.d.ts" />

// The adapter's own types.d.ts declares `App.Locals extends Runtime`, which
// supplies `cfContext` (waitUntil, passThroughOnException). This block merges
// our own fields into the same interface.
//
// Bindings are reached with `import { env } from 'cloudflare:workers'` —
// `Astro.locals.runtime.env` was removed in Astro v6 and now throws.
// Request metadata (country, colo, TLS) is on `Astro.request.cf`.
declare namespace App {
  interface Locals {
    /** Set by middleware when a valid session cookie is present. */
    user?: import('~/lib/auth/types').SessionUser;
  }
}
