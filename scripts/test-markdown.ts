/**
 * Post renderer checks.
 *
 * `renderMarkdown` is the whole XSS boundary for the blog: post bodies reach
 * readers through `set:html` on the public page and `dangerouslySetInnerHTML`
 * in the admin preview, with no sanitiser behind it. Nothing else stands
 * between an author's textarea and every reader's browser, so the escaping and
 * the URL allowlist need standing tests rather than a one-off manual pass.
 *
 *   npx tsx scripts/test-markdown.ts
 */

import { markdownToText, readingMinutes, renderMarkdown } from '../src/lib/markdown';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n         got      ${actual}\n         expected ${expected}`),
  );
  if (!ok) failures++;
}

/** The rendered output must not contain `needle` anywhere. */
function absent(label: string, source: string, needle: string): void {
  const html = renderMarkdown(source);
  const feed = renderMarkdown(source, { baseUrl: 'https://pogotxk.com' });
  const ok = !html.includes(needle) && !feed.includes(needle);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `\n         page ${html}\n         feed ${feed}`));
  if (!ok) failures++;
}

const B = '\\';

console.log('\n== raw HTML is text, not markup ==');
// Escape-first is the design: the renderer emits the only tags that exist, so
// there is no filter to defeat. These assert the escaping never regresses.
check(
  'script tag',
  renderMarkdown('<script>alert(1)</script>'),
  '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
);
check(
  'img with handler',
  renderMarkdown('<img src=x onerror=alert(1)>'),
  '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
);
absent('svg onload', '<svg onload=alert(1)></svg>', '<svg');
absent('iframe', '<iframe src="https://evil.example"></iframe>', '<iframe');
absent('html inside a fenced block', '```\n<script>alert(1)</script>\n```', '<script>');
absent('html inside a heading', '# <script>alert(1)</script>', '<script>');
absent('html inside a list item', '- <script>alert(1)</script>', '<script>');
absent('html inside a quote', '> <script>alert(1)</script>', '<script>');

console.log('\n== dangerous schemes are refused, link text survives ==');
check('javascript:', renderMarkdown('[click](javascript:alert(1))'), '<p>click</p>');
check('mixed case', renderMarkdown('[click](JaVaScRiPt:alert(1))'), '<p>click</p>');
check('vbscript:', renderMarkdown('[click](vbscript:msgbox(1))'), '<p>click</p>');
check('data:', renderMarkdown('[click](data:text/html,<b>x</b>)'), '<p>click</p>');
check('entity-encoded js', renderMarkdown('[click](&#106;avascript:alert(1))'), '<p>click</p>');
check('leading whitespace', renderMarkdown('[click]( javascript:alert(1))'), '<p>click</p>');
absent('js in an image src', '![x](javascript:alert(1))', 'javascript:');

console.log('\n== offsite-by-slash is refused ==');
// WHATWG URL parsing folds `\` into `/` for http(s), so `/\host` leaves the
// origin exactly like `//host` does. Both shapes have to be rejected, in the
// page and in the feed, for links and for images — an accepted image is a
// tracking pixel served to every reader.
absent('protocol-relative link', '[click](//evil.example/x)', 'evil.example');
absent('backslash-relative link', '[click](/' + B + 'evil.example/x)', 'evil.example');
absent('backslash-relative image', '![x](/' + B + 'evil.example/x.png)', 'evil.example');
absent('double backslash', '[click](/' + B + B + 'evil.example)', 'evil.example');
absent('scheme with one slash', '[click](https:/' + B + 'evil.example)', 'evil.example');
absent('bare backslash host', '[click](' + B + B + 'evil.example/x)', 'evil.example');

console.log('\n== legitimate URLs still work ==');
check(
  'https gets target and rel',
  renderMarkdown('[x](https://example.com)'),
  '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a></p>',
);
check('mailto', renderMarkdown('[m](mailto:a@b.com)'), '<p><a href="mailto:a@b.com">m</a></p>');
check('tel', renderMarkdown('[t](tel:+15551234567)'), '<p><a href="tel:+15551234567">t</a></p>');
check('site-relative', renderMarkdown('[r](/blog/x)'), '<p><a href="/blog/x">r</a></p>');
check('anchor', renderMarkdown('[a](#s)'), '<p><a href="#s">a</a></p>');
check(
  'balanced parens survive',
  renderMarkdown('[p](https://en.wikipedia.org/wiki/Pikachu_(disambiguation))'),
  '<p><a href="https://en.wikipedia.org/wiki/Pikachu_(disambiguation)" target="_blank" rel="noopener noreferrer">p</a></p>',
);
check(
  'baseUrl absolutises site-relative links for the feed',
  renderMarkdown('[r](/blog/x)', { baseUrl: 'https://pogotxk.com' }),
  '<p><a href="https://pogotxk.com/blog/x">r</a></p>',
);
check(
  'baseUrl leaves external links alone',
  renderMarkdown('[x](https://example.com)', { baseUrl: 'https://pogotxk.com' }),
  '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a></p>',
);

console.log('\n== attributes cannot be broken out of ==');
// A quote inside a quoted attribute is `&quot;`, which is inert — assert the
// literal `"` never reappears where it could open a new attribute.
absent('alt text', '![" onerror="alert(1)](https://ok.example/a.png)', 'onerror="');
absent('link title', '[x](https://ok.example "a" onmouseover="alert(1)")', 'onmouseover="');
absent('url body', '[x](https://ok.example/"onmouseover="alert(1))', 'onmouseover="');

console.log('\n== blocks ==');
check('heading offset: # is h2', renderMarkdown('# Title'), '<h2 id="title">Title</h2>');
check(
  'headingOffset 0 gives h1',
  renderMarkdown('# Title', { headingOffset: 0 }),
  '<h1 id="title">Title</h1>',
);
check('h6 does not overflow', renderMarkdown('###### D'), '<h6 id="d">D</h6>');
check('rule', renderMarkdown('---'), '<hr />');
check('emphasis', renderMarkdown('**b** and *i* and ~~s~~'), '<p><strong>b</strong> and <em>i</em> and <del>s</del></p>');
check('inline code keeps markdown literal', renderMarkdown('`**not bold**`'), '<p><code>**not bold**</code></p>');
check('tight list', renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
check('ordered list start', renderMarkdown('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
check('nested list', renderMarkdown('- a\n  - b'), '<ul><li>a<ul><li>b</li></ul></li></ul>');
check('quote', renderMarkdown('> hi'), '<blockquote><p>hi</p></blockquote>');
check('hard break', renderMarkdown('a  \nb'), '<p>a<br />\nb</p>');
check('soft wrap is a space', renderMarkdown('a\nb'), '<p>a b</p>');
check(
  'lone image becomes a figure',
  renderMarkdown('![alt](https://ok.example/a.png "cap")'),
  '<figure><img src="https://ok.example/a.png" alt="alt" loading="lazy" decoding="async" /><figcaption>cap</figcaption></figure>',
);
check('empty source', renderMarkdown(''), '');
check('unterminated fence still closes', renderMarkdown('```\nx').endsWith('</code></pre>'), true);

console.log('\n== text extraction ==');
check('strips syntax', markdownToText('# Hi\n\nSome **bold** text.'), 'Hi Some bold text.');
check('keeps link labels', markdownToText('see [the map](/map)'), 'see the map');
check('drops images', markdownToText('![alt](/a.png) after'), 'after');
check('cuts on a word boundary', markdownToText('alpha bravo charlie delta', 14), 'alpha bravo…');
check('reading time has a floor of 1', readingMinutes(''), 1);
check('reading time at 220 wpm', readingMinutes('word '.repeat(440)), 2);

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
