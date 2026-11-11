#!/usr/bin/env node
// Smoke test for the "lsp" MCP server: runs scripts/lsp/mcp.mjs in a checkout over stdio (which starts that
// checkout's lspd daemon if needed), lists its tools and asks each language server for hover, definition,
// references and diagnostics on a real file.
//
// Usage: node scripts/lsp/check.mjs [--root <checkout>] [--only csharp,typescript,...]
// Exit code 0 when every probed language answered.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const root = path.resolve(opt('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')));
const only = opt('only', '')?.split(',').filter(Boolean);

// [language, file, 1-based line, 1-based column of a symbol on that line]
const PROBES = [
  ['csharp', 'src/Catalog.API/Apis/CatalogApi.cs', 13, 42], // MapCatalogApi
  ['typescript', 'e2e/teststack/catalog-api.spec.ts', 20, 16], // getJson
  ['bash', 'scripts/graphify-build.sh', 0, 0],
  ['json', 'package.json', 0, 0],
  ['yaml', '.github/dependabot.yml', 0, 0],
].filter(([lang]) => !only?.length || only.includes(lang));

const child = spawn(process.execPath, [path.join(root, 'scripts/lsp/mcp.mjs')], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
let nextId = 1;
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
const call = async (name, args) => {
  const res = await request('tools/call', { name, arguments: args });
  const text = res.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(res.error);
  return { ok: !res.error && !res.result?.isError, text };
};
const short = (s, n = 160) => s.replace(/\s+/g, ' ').slice(0, n);

let failed = 0;
const started = Date.now();
const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'lsp-check', version: '1' },
});
console.log(`root: ${root}`);
console.log(`server: ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const tools = (await request('tools/list', {})).result.tools;
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);

for (const [lang, rel, line, column] of PROBES) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.log(`\n[${lang}] skipped, ${rel} not found`);
    continue;
  }
  const t0 = Date.now();
  console.log(`\n[${lang}] ${rel}`);
  const results = [];
  if (line) {
    // The first request also waits for the server to load the workspace.
    results.push(['hover', await call('lsp_hover', { file_path: file, line, column })]);
    results.push(['definition', await call('lsp_goto_definition', { file_path: file, line, column })]);
    results.push(['references', await call('lsp_find_references', { file_path: file, line, column, include_declaration: true })]);
  } else {
    results.push(['symbols', await call('lsp_document_symbols', { file_path: file })]);
  }
  results.push(['diagnostics', await call('lsp_diagnostics', { file_path: file })]);
  for (const [what, r] of results) {
    if (!r.ok) failed++;
    let summary = short(r.text);
    try {
      const data = JSON.parse(r.text);
      const list = data.references ?? data.definitions ?? data.symbols ?? data.diagnostics;
      if (Array.isArray(list)) {
        const where = [...new Set(list.map((x) => x.path && `${path.relative(root, x.path)}:${x.line}`).filter(Boolean))];
        summary = `${list.length} result(s)${where.length ? ` ${where.slice(0, 4).join(', ')}${where.length > 4 ? ', ...' : ''}` : ''}`;
      }
    } catch {
      // not JSON: keep the text
    }
    console.log(`  ${r.ok ? 'ok ' : 'ERR'} ${what}: ${summary}`);
  }
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
console.log(`\n${failed ? `${failed} call(s) failed` : 'all calls answered'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
child.kill();
process.exit(failed ? 1 : 0);
