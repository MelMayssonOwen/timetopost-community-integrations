// Runs from the base branch against a pull request checked out as plain data.
// Usage: check-pr.ts <base-dir> <pr-dir> <changed-files.txt>   env: PR_AUTHOR, PR_ASSOCIATION
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALLOWED_FILES, checkAdapter, loadManifest } from './lib.ts';
import { checkBacklink } from './backlink.ts';

const [baseArg, prArg, changedArg] = process.argv.slice(2);
const base = resolve(baseArg);
const pr = resolve(prArg);
const author = (process.env.PR_AUTHOR ?? '').toLowerCase();
const trusted = ['OWNER', 'MEMBER'].includes(process.env.PR_ASSOCIATION ?? '');
const changed = readFileSync(changedArg, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);

const fail = (messages: string[]): never => {
  console.log('This pull request cannot be merged yet:');
  for (const message of messages) console.log(`  - ${message}`);
  process.exit(1);
};

const ids = new Set<string>();
const outside: string[] = [];
for (const file of changed) {
  const match = /^integrations\/([a-z0-9][a-z0-9-]{1,39})\/([^/]+)$/.exec(file);
  if (match && ALLOWED_FILES.has(match[2])) ids.add(match[1]);
  else outside.push(file);
}
if (outside.length) {
  if (trusted) { console.log(`Maintainer change outside integrations/: ${outside.join(', ')}`); }
  else fail(outside.map(file => `${file}: a contribution may only change integrations/<id>/manifest.json, tests.json or logo.svg`));
}
if (ids.size === 0) { console.log('No adapter changed.'); process.exit(0); }
if (ids.size > 1) fail([`one adapter per pull request, this one changes ${[...ids].join(', ')}`]);
const id = [...ids][0];
if (!existsSync(resolve(pr, 'integrations', id, 'manifest.json'))) { if (trusted) { console.log(`${id} removed by a maintainer.`); process.exit(0); } fail([`${id}: removing an adapter is done by a maintainer`]); }

const errors = checkAdapter(pr, id);
if (errors.length) fail(errors);
const manifest = loadManifest(pr, id);

if (!trusted) {
  if (manifest.maintainer.firstParty) fail(['maintainer.firstParty is reserved for TimeToPost maintainers']);
  if (manifest.maintainer.github.toLowerCase() !== author) fail([`maintainer.github must be your GitHub username (${author})`]);
  if (existsSync(resolve(base, 'integrations', id, 'manifest.json')) && loadManifest(base, id).maintainer.github.toLowerCase() !== author) fail([`${id} is maintained by someone else. Open an issue to take it over.`]);
}

if (manifest.maintainer.firstParty) {
  console.log(`ok: ${id} is first party, the backlink rule does not apply.`);
} else {
  const verdict = await checkBacklink(manifest.backlink!.page, manifest.siteUrl);
  if (!verdict.ok) fail([`backlink on ${manifest.backlink!.page}: ${verdict.reason}`]);
  else console.log(`ok: found the backlink ${verdict.href}`);
}
console.log(`ok: ${id} passed. A maintainer still reviews every adapter before merge.`);
