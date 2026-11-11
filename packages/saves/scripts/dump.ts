/**
 * Prints the variable tree of a Witcher 3 save, for developers working out
 * where things live in a save. Not part of the app.
 *
 *   pnpm --filter @atlas/saves dump <file.sav> [options]
 *
 *   --summary          print what the reader makes of the save, as JSON
 *   --depth <n>        stop below this depth (default: no limit)
 *   --under <name>     only the branches under blocks of this name (any depth)
 *   --grep <text>      only lines that contain the text (case ignored), with their path
 *   --max <n>          cut values longer than this many characters (default 160)
 *   --facts            print every fact and its value
 *
 * It reads the file and prints; it never writes anything. A save holds the
 * player's character name and progress: keep dumps of real saves out of
 * repositories and issues.
 */

import { readFileSync } from 'node:fs';
import { readWitcher3, readWitcher3Tree } from '../src/witcher3/reader';
import { nodeValue } from '../src/witcher3/summary';
import { walk, type SaveNode } from '../src/witcher3/tree';
import type { SaveValue } from '../src/witcher3/values';

interface Options {
  file: string;
  summary: boolean;
  facts: boolean;
  depth: number;
  under: string | null;
  grep: string | null;
  max: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    file: '',
    summary: false,
    facts: false,
    depth: Infinity,
    under: null,
    grep: null,
    max: 160,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === '--summary') options.summary = true;
    else if (arg === '--facts') options.facts = true;
    else if (arg === '--depth') options.depth = Number(next());
    else if (arg === '--under') options.under = next().toLowerCase();
    else if (arg === '--grep') options.grep = next().toLowerCase();
    else if (arg === '--max') options.max = Number(next());
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.file = arg;
  }
  if (!options.file)
    throw new Error(
      'usage: dump <file.sav> [--summary] [--facts] [--depth n] [--under name] [--grep text] [--max n]',
    );
  return options;
}

function show(value: SaveValue | undefined, max: number): string {
  if (value === undefined) return '';
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const bytes = new Uint8Array(readFileSync(options.file));

  if (options.summary || options.facts) {
    const summary = readWitcher3(bytes);
    if (options.facts) {
      for (const [name, value] of Object.entries(summary.facts).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        console.log(`${name} = ${value}`);
      }
    }
    if (options.summary)
      console.log(
        JSON.stringify({ ...summary, facts: Object.keys(summary.facts).length }, null, 2),
      );
    return;
  }

  const tree = readWitcher3Tree(bytes);
  const { header, names } = tree.payload;
  console.log(
    `save version ${header.saveVersion}, game version ${header.gameVersion}, format ${header.formatVersion}; ` +
      `${tree.entries} variables, ${names.length} names, ${tree.payload.data.length - tree.payload.start} bytes unpacked`,
  );
  const label = (node: SaveNode) =>
    node.kind === 'raw'
      ? `raw @${node.offset}+${node.size}`
      : `${node.kind} ${node.name ?? (node.kind === 'SS' ? 'stream' : '?')}${node.type ? ` : ${node.type}` : ''}`;

  walk(tree.top, (node, ancestors) => {
    if (ancestors.length > options.depth) return;
    if (options.under && ![...ancestors, node].some((n) => n.name?.toLowerCase() === options.under))
      return;
    const value =
      node.kind === 'VL' || node.kind === 'OP' ? show(nodeValue(tree, node), options.max) : '';
    const line = `${'  '.repeat(ancestors.length)}${label(node)}${node.kind === 'BS' ? ` (${node.children.length})` : ''}${value ? ` = ${value}` : ''}  [${node.offset}+${node.size}]`;
    if (options.grep) {
      if (!line.toLowerCase().includes(options.grep)) return;
      const path = [...ancestors.map((a) => a.name ?? a.kind), node.name ?? node.kind].join(' > ');
      console.log(`${path}${value ? ` = ${value}` : ''}  [${node.offset}+${node.size}]`);
      return;
    }
    console.log(line);
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
