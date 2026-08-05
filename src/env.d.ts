/// <reference types="astro/client" />

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {
    /** Set by middleware when a valid session cookie is present. */
    user?: import('~/lib/auth/types').SessionUser;
  }
}
