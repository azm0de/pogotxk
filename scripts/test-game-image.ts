/**
 * The Leek Duck image proxy must never fetch from anywhere but their CDN.
 *
 * A route that takes a path and fetches it is one mistake away from being an
 * open proxy, and this codebase has shipped the *same* origin-escape bypass
 * twice already — once in the markdown URL allowlist (`/\host`) and once in the
 * sign-in `next` parameter. Both times the check pattern-matched the string
 * instead of asking the URL parser where it actually resolves.
 *
 * So these assertions resolve every candidate and compare origins, the same way
 * test-markdown-urls.ts and the safeNext block in test-auth.ts do.
 *
 *   npx tsx scripts/test-game-image.ts
 */

import {
  isRenderableImage,
  LEEKDUCK_CDN,
  leekduckPath,
  proxiedImageUrl,
} from '../src/lib/game-image';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}${
      ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
    }`,
  );
  if (!ok) failures++;
}

const BS = String.fromCharCode(92); // backslash, spelled out to survive tooling
const TAB = String.fromCharCode(9);

console.log('\n== leekduckPath: nothing may leave the CDN ==');

// Every one of these resolves somewhere. The only question is where.
const hostile = [
  '//evil.example/x.jpg',
  '/' + BS + 'evil.example/x.jpg',
  BS + BS + 'evil.example/x.jpg',
  'https://evil.example/x.jpg',
  'http://evil.example/x.jpg',
  '//' + TAB + 'evil.example/x.jpg',
  'https:evil.example/x.jpg',
  '/'.repeat(4) + 'evil.example/x.jpg',
  'javascript:alert(1)',
  'data:image/png;base64,AAAA',
  'file:///etc/passwd',
];

for (const raw of hostile) {
  const resolved = leekduckPath(raw);
  check(
    `refused or kept on the CDN: ${JSON.stringify(raw)}`,
    resolved === null || resolved.origin === LEEKDUCK_CDN,
    true,
  );
}

// Traversal is allowed to resolve, as long as it resolves *upstream*. `../..`
// above the root is clamped by the URL parser, not by us.
console.log('\n== traversal stays on the CDN ==');
for (const raw of ['../../etc/passwd', 'a/../../../x.jpg', './x.jpg']) {
  const resolved = leekduckPath(raw);
  check(`${JSON.stringify(raw)} -> CDN origin`, resolved?.origin ?? null, LEEKDUCK_CDN);
}

console.log('\n== legitimate paths still work ==');
check(
  'plain asset path',
  leekduckPath('assets/img/events/pokemonspotlighthour.jpg')?.toString(),
  `${LEEKDUCK_CDN}/assets/img/events/pokemonspotlighthour.jpg`,
);
check(
  'nested article image',
  leekduckPath('assets/img/events/article-images/2026/e/e.jpg')?.toString(),
  `${LEEKDUCK_CDN}/assets/img/events/article-images/2026/e/e.jpg`,
);
check('empty path refused', leekduckPath(''), null);

console.log('\n== proxiedImageUrl: rewrite only what is ours to rewrite ==');
check(
  'CDN url is rewritten to our route',
  proxiedImageUrl(`${LEEKDUCK_CDN}/assets/img/events/x.jpg`),
  '/img/leekduck/assets/img/events/x.jpg',
);
check('local media path passes through', proxiedImageUrl('/media/legacy/a.jpg'), '/media/legacy/a.jpg');
check('protocol-relative is not treated as local', proxiedImageUrl('//evil.example/x.jpg'), null);
check('foreign host is refused, not rehosted', proxiedImageUrl('https://evil.example/x.jpg'), null);
check('http CDN is refused (origin includes scheme)', proxiedImageUrl('http://cdn.leekduck.com/x.jpg'), null);
check('lookalike host refused', proxiedImageUrl('https://cdn.leekduck.com.evil.example/x.jpg'), null);
check('null in, null out', proxiedImageUrl(null), null);
check('garbage in, null out', proxiedImageUrl('not a url'), null);

// The round trip is the real invariant: whatever the rewriter emits, the
// resolver must map back onto the CDN and nowhere else.
console.log('\n== round trip ==');
for (const raw of [
  `${LEEKDUCK_CDN}/assets/img/events/a.jpg`,
  `${LEEKDUCK_CDN}/assets/img/events/article-images/2026/x/y%20z.jpg`,
  `${LEEKDUCK_CDN}/a/../b.jpg`,
]) {
  const proxied = proxiedImageUrl(raw);
  const back = proxied ? leekduckPath(proxied.replace('/img/leekduck/', '')) : null;
  check(`${JSON.stringify(raw)} survives`, back?.origin ?? null, LEEKDUCK_CDN);
}

console.log('\n== content types ==');
check('jpeg allowed', isRenderableImage('image/jpeg'), true);
check('charset parameter tolerated', isRenderableImage('image/png; charset=binary'), true);
check('uppercase tolerated', isRenderableImage('IMAGE/WEBP'), true);
check('html refused', isRenderableImage('text/html'), false);
check('svg refused (scriptable)', isRenderableImage('image/svg+xml'), false);
check('missing refused', isRenderableImage(null), false);

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
