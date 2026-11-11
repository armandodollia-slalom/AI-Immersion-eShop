#!/usr/bin/env node
// Minimal stdio language server for lspd tests: answers initialize, hover and shutdown, and reports itself ready
// through $LSPD_STATE_DIR/csharp.json the way scripts/lsp/roslyn-proxy.mjs does.
import fs from 'node:fs';
import path from 'node:path';

const state = (s) => process.env.LSPD_STATE_DIR && fs.writeFileSync(path.join(process.env.LSPD_STATE_DIR, 'csharp.json'), JSON.stringify({ state: s, pid: process.pid }));
const send = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
    buf = buf.subarray(end + 4 + len);
    if (msg.method === 'initialize') send({ id: msg.id, result: { capabilities: { hoverProvider: true, textDocumentSync: 1 } } });
    else if (msg.method === 'initialized') state('ready');
    else if (msg.method === 'textDocument/hover') send({ id: msg.id, result: { contents: 'fake hover' } });
    else if (msg.method === 'shutdown') send({ id: msg.id, result: null });
    else if (msg.method === 'exit') {
      state('exited');
      process.exit(0);
    } else if (msg.id !== undefined) send({ id: msg.id, result: null });
  }
});
state('starting');
