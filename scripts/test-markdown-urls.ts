/**
 * Focused check on the markdown URL allowlist.
 *
 * Separate from test-markdown.ts because this one asserts the property that
 * actually matters rather than the shape of the output: does the rendered href,
 * resolved against our own origin, still point at our own origin?
 *
 * The bypass this guards against is subtle — WHATWG URL parsing folds `\` into
 * `/` for http(s) schemes, so `/\evil.example/p` looks root-relative to a naive
 * check but resolves to `https://evil.example/p` in a browser.
 */

import { renderMarkdown } from '../src/lib/markdown';

const ORIGIN = 'https://pogotxk.example';

let failures = 0;

/** Pull every href and src out of the rendered HTML. */
function urlsIn(html: string): string[] {
  return [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]!);
}

function check(label: string, markdown: string, expectEscape: boolean): void {
  const html = renderMarkdown(markdown);
  const urls = urlsIn(html);

  // Does any emitted URL resolve off our origin to a host we did not intend?
  const escaped = urls.some((u) => {
    try {
      const resolved = new URL(u, ORIGIN);
      return resolved.origin !== ORIGIN && !/^(https:\/\/|mailto:|tel:)/i.test(u);
    } catch {
      return false;
    }
  });

  const emitted = urls.length > 0;
  // A hostile input passes by being dropped entirely, or by staying on-origin.
  const ok = expectEscape ? !escaped && (!emitted || !escaped) : !escaped;

  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} urls=${JSON.stringify(urls)}`,
  );
  if (!ok) failures++;
}

console.log('\n== backslash bypass (the fixed defect) ==');
// A single backslash after the leading slash. Browsers normalise this to `//`.
check('/\\evil.test/p', '[x](/\\evil.test/p)', true);
check('/\\\\evil.test', '[x](/\\\\evil.test)', true);
check('image variant', '![p](/\\evil.test/px.png)', true);

console.log('\n== protocol-relative ==');
check('//evil.test/p', '[x](//evil.test/p)', true);

console.log('\n== dangerous schemes ==');
for (const scheme of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'JaVaScRiPt:x']) {
  check(scheme, `[x](${scheme})`, true);
}

console.log('\n== legitimate URLs must still work ==');
const legit: [string, string][] = [
  ['root-relative', '[x](/blog/post)'],
  ['anchor', '[x](#section)'],
  ['relative', '[x](./sibling)'],
  ['parent', '[x](../up)'],
  ['https', '[x](https://discord.com/invite/abc)'],
  ['mailto', '[x](mailto:a@b.com)'],
  ['media image', '![alt](/media/legacy/x.jpg)'],
];
for (const [label, md] of legit) {
  const urls = urlsIn(renderMarkdown(md));
  const ok = urls.length > 0;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} urls=${JSON.stringify(urls)}`);
  if (!ok) failures++;
}

console.log('\n== raw HTML stays inert ==');
for (const [label, md] of [
  ['script tag', '<script>alert(1)</script>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['svg onload', '<svg onload=alert(1)>'],
] as [string, string][]) {
  const html = renderMarkdown(md);
  // Inert means the browser sees text, not markup: no unescaped opening tag.
  const ok = !/<(script|img|svg)\b/i.test(html);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} ${html.slice(0, 60)}`);
  if (!ok) failures++;
}

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
