/**
 * Checks pack folders on disk against the pack schema, its integrity rules
 * and their tile folders (see `validatePackFolder`).
 *
 *   tsx src/cli/validate-pack.ts <pack folder> [<pack folder> ...]
 *
 * Exits with 1 and lists the problems when a pack is not valid.
 */

import { resolve } from 'node:path';
import { validatePackFolder } from '../pack/validateFolder';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('Usage: tsx src/cli/validate-pack.ts <pack folder> [...]');
  process.exit(2);
}
let failed = false;
for (const dir of dirs) {
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), dir);
  const report = await validatePackFolder(path);
  if (report.problems.length > 0) {
    failed = true;
    console.error(`${path}: not a valid pack`);
    for (const problem of report.problems) console.error(`  - ${problem}`);
  } else {
    console.log(
      `${path}: valid (${report.files.length} files, ${report.tilesChecked} tiles checked)`,
    );
  }
}
process.exit(failed ? 1 : 0);
