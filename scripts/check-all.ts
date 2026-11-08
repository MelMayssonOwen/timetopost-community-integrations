import { resolve } from 'node:path';
import { adapterIds, checkAdapter } from './lib.ts';

const root = resolve(process.argv[2] ?? '.');
let failed = false;
for (const id of adapterIds(root)) {
  const errors = checkAdapter(root, id);
  console.log(errors.length ? `FAIL ${id}` : `ok   ${id}`);
  for (const error of errors) { failed = true; console.log(`  - ${error}`); }
}
process.exit(failed ? 1 : 0);
