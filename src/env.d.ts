/// <reference types="astro/client" />

// Bindings are reached with `import { env } from 'cloudflare:workers'`.
// `Astro.locals.runtime.env` was removed in Astro v6 and now throws.
//
// `Astro.locals.cfContext` carries the ExecutionContext (waitUntil, passThroughOnException).
// Request metadata (country, colo, TLS) is on `Astro.request.cf`.
declare namespace App {
  interface Locals extends import('@astrojs/cloudflare').Runtime {
    // A `user` field gets added here when Discord auth lands.
  }
}
