/**
 * The href guard every admin-entered link passes through, accepted and
 * rendered alike — see src/lib/safe-url.ts.
 *
 *   npx tsx scripts/test-safe-url.ts
 *
 * Written because `z.string().url()` was the gate and it accepts
 * `javascript:alert(1)` (admin audit, 2026-10, B-02/B-03). Each refusal below is
 * a shape that reaches a browser's address bar as something other than a web
 * page, so each one is asserted on its own rather than as a family.
 */

import { httpUrlOrNull, isHttpUrl, MAX_URL_LENGTH } from '../src/lib/safe-url';

let failures = 0;
let passes = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n         got      ${String(actual)}\n         expected ${String(expected)}`}`,
  );
  if (ok) passes++;
  else failures++;
}

function refuses(label: string, raw: unknown): void {
  check(`refuses ${label}`, httpUrlOrNull(raw), null);
}

console.log('\n== scripts that are not web pages ==');
refuses('javascript:', 'javascript:alert(1)');
refuses('JAVASCRIPT: in capitals', 'JAVASCRIPT:alert(1)');
refuses('mixed-case JavaScript:', 'JavaScript:alert(document.cookie)');
refuses('javascript: with a leading space', '  javascript:alert(1)');
refuses('data:', 'data:text/html,<script>alert(1)</script>');
refuses('DATA: in capitals', 'DATA:text/html;base64,PHNjcmlwdD4=');
refuses('vbscript:', 'vbscript:msgbox(1)');
refuses('file:', 'file:///etc/passwd');
refuses('ftp:', 'ftp://example.com/');
refuses('mailto:', 'mailto:someone@example.com');

console.log('\n== relative shapes a browser resolves somewhere else ==');
refuses('scheme-relative //evil', '//evil.example/path');
refuses('slash-backslash /\\evil', '/\\evil.example');
refuses('backslash-backslash \\\\evil', '\\\\evil.example');
refuses('a bare path', '/events');
refuses('a bare host', 'campfire.nianticlabs.com/event');
refuses('https:\\\\ with backslashes', 'https:\\\\evil.example');
refuses('a backslash in the path', 'https://example.com\\@evil.example');

console.log('\n== whitespace and control characters the parser would strip ==');
refuses('a tab inside the scheme', 'java\tscript:alert(1)');
refuses('a newline inside the scheme', 'java\nscript:alert(1)');
refuses('a CR inside the scheme', 'java\rscript:alert(1)');
refuses('a tab inside an http URL', 'https://exa\tmple.com/');
refuses('a newline inside an http URL', 'https://example.com/\nSet-Cookie: x');
refuses('a space inside an http URL', 'https://example.com/a b');
refuses('a NUL byte', 'https://example.com/\u0000');
refuses('a C1 control', 'https://example.com/\u0085');
refuses('DEL', 'https://example.com/\u007f');

console.log('\n== credentials, length, and things that are not strings ==');
refuses('user:pass@host', 'https://user:pass@example.com/');
refuses('user@host', 'https://user@example.com/');
refuses('an empty string', '');
refuses('only whitespace', '   ');
refuses('null', null);
refuses('undefined', undefined);
refuses('a number', 42);
refuses('an object', { href: 'https://example.com' });
refuses('no host', 'https://');
refuses('longer than the cap', `https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`);
check(
  'a caller-supplied cap is honoured',
  httpUrlOrNull('https://example.com/abcdef', 20),
  null,
);

console.log('\n== real links ==');
check('https', httpUrlOrNull('https://example.com/a?b=c#d'), 'https://example.com/a?b=c#d');
check('http', httpUrlOrNull('http://example.com/'), 'http://example.com/');
check('HTTPS in capitals is normalised', httpUrlOrNull('HTTPS://Example.COM/Path'), 'https://example.com/Path');
check('surrounding whitespace is forgiven', httpUrlOrNull('  https://example.com/  '), 'https://example.com/');
check('a bare origin gains its slash', httpUrlOrNull('https://example.com'), 'https://example.com/');
check(
  'a Campfire link survives untouched',
  httpUrlOrNull('https://campfire.nianticlabs.com/discover/meetup/abc-123'),
  'https://campfire.nianticlabs.com/discover/meetup/abc-123',
);
check('a port is fine', httpUrlOrNull('https://example.com:8443/x'), 'https://example.com:8443/x');
check(
  'percent-encoding is fine',
  httpUrlOrNull('https://example.com/a%20b'),
  'https://example.com/a%20b',
);
check('isHttpUrl agrees on a good one', isHttpUrl('https://example.com/'), true);
check('isHttpUrl agrees on a bad one', isHttpUrl('javascript:alert(1)'), false);

console.log(failures ? `\nFAILED (${failures})\n` : `\nAll ${passes} checks passed.\n`);
process.exit(failures ? 1 : 0);
