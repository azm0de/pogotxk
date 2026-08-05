// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';

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
  },
});
