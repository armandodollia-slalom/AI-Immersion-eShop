#!/usr/bin/env node
// Writes a solution filter with the projects a story owns plus their transitive ProjectReferences.
//
// Usage: node scripts/lsp/slnf.mjs --owns <glob> [--owns <glob>...] --out <file.slnf> [--root <checkout>] [--solution eShop.slnx]
// Prints {"ok":true,"projects":[...],"out":"..."}; exit 1 with {"ok":false,"error":"..."} otherwise.
import process from 'node:process';
import { generateSlnf } from './lib/slnf.mjs';
import { isMain } from './lib/common.mjs';

export { generateSlnf };

function parseArgs(argv) {
  const opts = { owns: [], root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owns') opts.owns.push(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--solution') opts.solution = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

if (isMain(import.meta.url)) {
  let result;
  try {
    result = generateSlnf(parseArgs(process.argv.slice(2)));
  } catch (error) {
    result = { ok: false, projects: [], error: error.message };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
