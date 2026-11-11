#!/usr/bin/env node
// Stand-in for scripts/lsp/lspd.mjs and scripts/lsp/slnf.mjs in tests. Logs every call to
// $FAKE_LSPD_LOG; diagnostics come from $FAKE_LSPD_DIAG (JSON {"files": {...}}).
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LSPD_LOG) fs.appendFileSync(process.env.FAKE_LSPD_LOG, `${JSON.stringify(args)}\n`);
const flag = (name) => args[args.indexOf(name) + 1];

if (args.includes('--out')) {
  fs.writeFileSync(flag('--out'), '{"solution":{"projects":[]}}');
  console.log(JSON.stringify({ ok: true, projects: ['src/Catalog.API/Catalog.API.csproj'] }));
} else if (args[0] === 'start') {
  console.log(JSON.stringify({ ok: true, pid: 4242, socket: '/tmp/x.sock', csharp: process.env.FAKE_LSPD_CSHARP ?? 'running' }));
} else if (args[0] === 'diagnostics') {
  console.log(JSON.stringify({ ok: true, ...(process.env.FAKE_LSPD_DIAG ? JSON.parse(process.env.FAKE_LSPD_DIAG) : { files: {} }) }));
} else {
  console.log(JSON.stringify({ ok: true }));
}
