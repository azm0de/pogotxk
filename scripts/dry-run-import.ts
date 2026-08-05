/**
 * Dry run of the legacy import against the live site — parses and transforms,
 * asserts the counts, and prints what *would* be written. Touches no database
 * and uploads nothing.
 *
 *   npx tsx scripts/dry-run-import.ts
 */

import {
  parseMarkers,
  parseMeetup,
  parseCoordArray,
  toGeoJsonLineString,
  toGeoJsonPolygon,
} from '../src/lib/legacy/parse';
import { transform } from '../src/lib/legacy/transform';

const ORIGIN = 'https://pokemontxk.com';

/** Counts taken from the live markers.js at v98. A mismatch means it changed. */
const EXPECTED = { pokestop: 66, gym: 15, specialgym: 1, powerspot: 22, communityphoto: 9 };

async function text(path: string): Promise<string> {
  const res = await fetch(new URL(path, ORIGIN));
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.text();
}

const problems: string[] = [];
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) problems.push(label);
};

const [markersJs, scriptJs, meetupJs] = await Promise.all([
  text('/markers.js'),
  text('/script.js'),
  text('/meetup.js'),
]);

console.log('\n== source ==');
const markers = parseMarkers(markersJs);
const byType = markers.reduce<Record<string, number>>((acc, m) => {
  acc[m.type] = (acc[m.type] ?? 0) + 1;
  return acc;
}, {});
check('total markers', markers.length, 113);
for (const [type, expected] of Object.entries(EXPECTED)) check(type, byType[type] ?? 0, expected);

console.log('\n== transform ==');
const { pois, media, poiPhotos, warnings } = transform(markers, ORIGIN);
check('POIs (66+15+1+22)', pois.length, 104);
check('campsite POIs', pois.filter((p) => p.isCampsite).length, 24);
check('meetup spots', pois.filter((p) => p.isMeetupSpot).length, 1);
// 96 of 113 markers carry an `image`. Of those, 24 are the ambassador Campsite
// icon (not a photo) and 9 belong to community-photo markers, leaving 63 real
// POI photographs and 72 media rows in total.
check('community photos', media.filter((m) => m.kind === 'community_photo').length, 9);
check('POI photos (96 - 24 icons - 9 community)', media.filter((m) => m.kind === 'photo').length, 63);
check('total media rows', media.length, 72);
check('unique slugs', new Set(pois.map((p) => p.slug)).size, pois.length);
check('unique r2 keys', new Set(media.map((m) => m.r2Key)).size, media.length);
check('POIs with a photo', poiPhotos.size, 63);

console.log('\n  slug disambiguation:');
for (const name of ['Walk Through History', 'Powerspot', 'Boy Scouts of America']) {
  const hits = pois.filter((p) => p.name === name);
  console.log(`    ${name} x${hits.length} -> ${hits.map((p) => `${p.slug}(${p.type})`).join(', ')}`);
}

console.log('\n  meetup spot:');
for (const p of pois.filter((x) => x.isMeetupSpot)) {
  console.log(`    ${p.name} | type=${p.type} campsite=${p.isCampsite} slug=${p.slug}`);
}

console.log('\n  attribution preserved:');
for (const m of media.filter((x) => x.credit || x.articleUrl).slice(0, 3)) {
  console.log(`    ${m.r2Key}`);
  console.log(`      credit: ${m.credit}`);
  console.log(`      source: ${m.sourceTitle} (${m.sourceDate})`);
  console.log(`      url:    ${m.articleUrl}`);
}
check(
  'community photos carrying credit',
  media.filter((m) => m.kind === 'community_photo' && m.credit).length,
  9,
);

console.log('\n  filename normalization:');
for (const m of media.filter((x) => /%|[#! ]/.test(x.sourceUrl)).slice(0, 5)) {
  console.log(`    ${decodeURIComponent(m.sourceUrl.split('/').pop()!)} -> ${m.r2Key}`);
}

console.log('\n== shapes ==');
const hotspot = parseCoordArray(scriptJs, 'hotspotBoundary');
const route = parseCoordArray(scriptJs, 'raidRouteCoordinates');
console.log(`  hotspot polygon: ${hotspot.length} points`);
console.log(`  raid route:      ${route.length} points`);
const poly = JSON.parse(toGeoJsonPolygon(hotspot));
const line = JSON.parse(toGeoJsonLineString(route));
check('polygon ring closed', JSON.stringify(poly.coordinates[0][0]), JSON.stringify(poly.coordinates[0].at(-1)));
// GeoJSON is [lng, lat]; Texarkana is ~33.46 N, ~-94.05 W.
const [lng0, lat0] = line.coordinates[0];
check('lng/lat order correct', lng0 < -90 && lat0 > 30, true);

console.log('\n== meetup ==');
const meetup = parseMeetup(meetupJs);
console.log(`  ${meetup.title} | ${meetup.date} | ${meetup.time} | @ ${meetup.location}`);
console.log(`  ${meetup.description}`);

if (warnings.length) {
  console.log('\n== warnings ==');
  for (const w of warnings) console.log(`  - ${w}`);
}

console.log(
  problems.length
    ? `\nFAILED (${problems.length}): ${problems.join(', ')}\n`
    : '\nAll checks passed.\n',
);
process.exit(problems.length ? 1 : 0);
