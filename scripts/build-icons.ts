/**
 * Rasterises public/favicon.svg into the PNG sizes a PWA install actually needs.
 *
 *   npx tsx scripts/build-icons.ts
 *
 * Run this after editing the SVG. The PNGs are committed rather than generated
 * at build time — Workers Builds should not need a native image toolchain, and
 * the icons change roughly never.
 *
 * Android reads the 192 and 512 from the manifest; the maskable variant carries
 * the extra padding Android crops into a circle. iOS ignores the manifest
 * entirely and uses apple-touch-icon, which must be opaque — a transparent PNG
 * renders black on the home screen.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const SVG = readFileSync('public/favicon.svg');
const OUT = 'public/icons';
mkdirSync(OUT, { recursive: true });

interface Target {
  file: string;
  size: number;
  /** Extra breathing room, as a fraction of the canvas, for maskable icons. */
  padding?: number;
}

const TARGETS: Target[] = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  // Android's maskable crop can take ~20% off each edge, so the artwork is
  // inset to survive it.
  { file: 'icon-maskable-192.png', size: 192, padding: 0.2 },
  { file: 'icon-maskable-512.png', size: 512, padding: 0.2 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'favicon-32.png', size: 32 },
];

for (const target of TARGETS) {
  const pad = Math.round(target.size * (target.padding ?? 0));
  const inner = target.size - pad * 2;

  const art = await sharp(SVG, { density: 384 }).resize(inner, inner).png().toBuffer();

  const canvas = sharp({
    create: {
      width: target.size,
      height: target.size,
      channels: 4,
      // Opaque brand navy: iOS composites apple-touch-icon over black, so a
      // transparent background would render as a black square.
      background: { r: 0x12, g: 0x32, b: 0x54, alpha: 1 },
    },
  }).composite([{ input: art, top: pad, left: pad }]);

  const png = await canvas.png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(`${OUT}/${target.file}`, png);
  console.log(`  ${target.file.padEnd(26)} ${target.size}x${target.size}  ${png.length} bytes`);
}

// Legacy /favicon.ico for anything that still asks for it by convention.
writeFileSync('public/favicon-32.png', readFileSync(`${OUT}/favicon-32.png`));
console.log('\nIcons written to public/icons/.');
