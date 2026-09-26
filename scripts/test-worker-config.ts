/**
 * wrangler.jsonc guards — settings whose absence deploys cleanly and then
 * fails in production with nothing pointing back at the config.
 *
 *   npx tsx scripts/test-worker-config.ts
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n         ${detail}`}`);
  if (!ok) failures++;
}

// TypeScript's config reader understands JSONC: comments and trailing commas.
const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
if (error) throw new Error(`wrangler.jsonc did not parse: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);

console.log('\n== Cron triggers ==');
// `wrangler deploy` skips schedules entirely when `triggers.crons` is absent,
// so a trigger removed from this file stays live on Cloudflare. Only an
// explicit list — `[]` for none — replaces what is deployed.
const crons = config.triggers?.crons;
check('triggers.crons is an explicit list', Array.isArray(crons),
  'an absent key leaves the old */30 schedule attached; set "triggers": { "crons": [] }');
// The Astro entry exports no scheduled() handler, so any cron here throws
// "Handler does not export a scheduled() function" on every run.
check('no cron on a Worker without scheduled()', Array.isArray(crons) && crons.length === 0,
  `found ${JSON.stringify(crons)}; put a cron on an auxiliary worker instead`);

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
