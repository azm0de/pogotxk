/**
 * Renders the admin password-reset mail to a file, so a person can look at it.
 *
 *   npm run preview:reset-email -- <out.html>
 *   npx tsx scripts/preview-reset-email.ts <out.html>
 *
 * Writes the HTML part to `<out.html>` and prints the plain-text part, both
 * exactly as `src/lib/notify/reset-email.ts` builds them for a real send —
 * this imports that module rather than keeping a copy, so the preview cannot
 * drift from the mail. Open the file in a browser; switch the computer to dark
 * mode to see the dark palette, which clients like Apple Mail use.
 *
 * NOTHING HERE SENDS ANYTHING. It never loads the mail sender, reads no
 * configuration and makes no request. The link is a dummy — 64 hex characters,
 * the shape of a real token, spelling nothing issued, so no row anywhere holds
 * its hash and it opens nothing.
 *
 * Put the output somewhere outside the working tree (a temp or scratch
 * folder). It is a rendering for looking at, not a source file, and it has no
 * business in a commit.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Relative, not `~/`: `tsx` does not read the alias from tsconfig.json. The
// module is written to load here — no `cloudflare:workers` anywhere under it.
import { resetMessage } from '../src/lib/notify/reset-email';

const out = process.argv[2];
if (!out) {
  console.error('\nUsage: npm run preview:reset-email -- <out.html>\n');
  process.exit(1);
}

/** A dummy token: the right shape, and plainly not a real one. */
const DUMMY_TOKEN = '0123456789abcdef'.repeat(4);

/** Production's host, so the preview shows the link a real mail would carry. */
const ORIGIN = 'https://pogotxk.gnomelabz.workers.dev';

const mail = resetMessage({
  link: `${ORIGIN}/admin/reset/${DUMMY_TOKEN}`,
  username: 'justin',
});

const path = resolve(out);
writeFileSync(path, mail.html, 'utf8');

console.log(`\nSubject: ${mail.subject}`);
console.log(`HTML part written to ${path}\n`);
console.log('--- plain-text part ---\n');
console.log(mail.text);
console.log('\n--- end ---\n');
