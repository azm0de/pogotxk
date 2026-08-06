// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';

const LIVE_BOARD = fileURLToPath(new URL('./src/do/LiveBoard.ts', import.meta.url)).replace(
  /\\/g,
  '/',
);

/**
 * Re-exports the Durable Object class from the Worker entry.
 *
 * Cloudflare instantiates a Durable Object by looking for a named export on the
 * deployed script, and a `durable_objects` binding naming a class the entry does
 * not export fails the deploy outright. The Astro adapter builds its entry from
 * a virtual module that only ever exports `default`, and exposes no option to
 * add to it — so this appends the export to that module directly.
 *
 * The id is matched loosely because Vite prefixes virtual modules with a NUL
 * (`\0virtual:cloudflare/worker-entry`), and that prefix is an implementation
 * detail worth not depending on.
 *
 * If a future adapter version stops using this module id, the build still
 * succeeds and the deploy fails loudly on the missing class — which is the
 * failure mode you want, rather than a Worker that silently drops WebSockets.
 */
function exportDurableObjects() {
  return {
    name: 'pogotxk:export-durable-objects',
    // Must run after the Cloudflare plugin has produced the module.
    enforce: 'post',
    transform(code, id) {
      if (!id.includes('virtual:cloudflare/worker-entry')) return null;
      return {
        code: `${code}\nexport { LiveBoard } from ${JSON.stringify(LIVE_BOARD)};\n`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  site: 'https://pokemontxk.com',

  // SSR by default — most pages read from D1. Static pages opt out per-file
  // with `export const prerender = true`.
  output: 'server',

  adapter: cloudflare({
    // Resize/format R2-hosted originals at the edge.
    imageService: 'cloudflare',
  }),

  integrations: [react()],

  vite: {
    // Leaflet ships its own CSS and expects a browser global; keep it out of SSR.
    ssr: { noExternal: ['leaflet', 'leaflet.markercluster'] },
    plugins: [exportDurableObjects()],
  },
});
