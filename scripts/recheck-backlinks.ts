// Nightly: lists adapters whose required backlink has gone. Output is the issue body.
import { resolve } from 'node:path';
import { adapterIds, loadManifest } from './lib.ts';
import { checkBacklink } from './backlink.ts';

const root = resolve(process.argv[2] ?? '.');
const broken: string[] = [];
for (const id of adapterIds(root)) {
  const manifest = loadManifest(root, id);
  if (manifest.maintainer.firstParty || !manifest.backlink) continue;
  const verdict = await checkBacklink(manifest.backlink.page, manifest.siteUrl);
  if (!verdict.ok) broken.push(`- **${id}** (@${manifest.maintainer.github}): ${manifest.backlink.page}: ${verdict.reason}`);
}
if (broken.length) {
  console.log(`These listings no longer meet the backlink rule. Maintainers have 14 days to restore the link before the listing is removed.\n\n${broken.join('\n')}`);
}
