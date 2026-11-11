#!/usr/bin/env node
// Mockup helpers for the UI verifier (and people): render mockup screens to PNGs, and a pixel diff of a
// mockup render against an app screenshot as supporting evidence. See docs/ai-pipeline/implement.md#ui-verification.
import path from 'node:path';
import { pixelDiff, renderMockups } from './lib/mockups.mjs';

const USAGE = `Usage: node scripts/implement/mockups.mjs <command>

  render <out-dir> <mockup file...>        render every .dc.html/.html screen and state to <out-dir>/*.png
                                           (manifest.json lists them; cached under <out-dir>/../.mockup-cache)
  diff <mockup.png> <actual.png> <out.png> write a diff image (differing pixels in red) and print the
                                           differing pixel ratio. Evidence only, never a verdict on its own.`;

async function main([command, ...args]) {
  if (command === 'render' && args.length >= 2) {
    const [out, ...files] = args;
    const r = await renderMockups({ files: files.map((f) => path.resolve(f)), outDir: path.resolve(out), cacheDir: path.join(path.dirname(path.resolve(out)), '.mockup-cache') });
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  if (command === 'diff' && args.length === 3) {
    console.log(JSON.stringify(await pixelDiff(...args.map((a) => path.resolve(a))), null, 2));
    return 0;
  }
  console.log(USAGE);
  return command ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
