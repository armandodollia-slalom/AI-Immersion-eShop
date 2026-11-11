#!/usr/bin/env node
// MCP stdio server "lsp" for agents: connects to the lspd daemon of the checkout containing the current directory
// (starting it when none runs) and relays MCP messages. It never talks to another checkout's daemon.
// Every tools/call is appended to <git-dir>/lsp/calls.jsonl for metrics.
// Registered in .mcp.json (Claude Code and Copilot CLI) and .codex/config.toml.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_DIR, connect, daemonPaths, realWorktree, stateDir, worktreeOf } from './lib/common.mjs';
import { ensureDaemon } from './lspd.mjs';

let worktree;
try {
  worktree = realWorktree(worktreeOf(process.cwd()));
} catch {
  worktree = realWorktree(REPO_DIR); // not started inside a git checkout: serve the checkout holding this script
}

const fail = (message) => {
  process.stderr.write(`eshop-lsp: ${message}\n`);
  process.exit(1);
};

let conn;
try {
  await ensureDaemon(worktree, { slnf: process.env.LSP_SLNF || undefined });
  conn = await connect(daemonPaths(worktree).socket, 5000);
} catch (error) {
  fail(`cannot reach the language-server daemon for ${worktree}: ${error.message}`);
}

const callLog = path.join(stateDir(worktree), 'calls.jsonl');
const agent = process.env.PIPELINE_AGENT_NAME ?? null;

function logCall(msg) {
  const args = msg.params?.arguments ?? {};
  const symbol = args.query ?? args.name ?? args.new_name ?? (args.line ? `${args.line}:${args.column ?? ''}` : null);
  const entry = { ts: new Date().toISOString(), agent, tool: msg.params?.name ?? null, file: args.file_path ?? null, symbol };
  try {
    fs.appendFileSync(callLog, `${JSON.stringify(entry)}\n`);
  } catch {
    // metrics are best effort
  }
}

conn.write(`${JSON.stringify({ lspd: 'mcp', agent })}\n`);
conn.pipe(process.stdout);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl + 1);
    buffer = buffer.slice(nl + 1);
    if (line.includes('"tools/call"')) {
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'tools/call') logCall(msg);
      } catch {
        // forwarded as is; the daemon answers parse errors
      }
    }
    conn.write(line);
  }
});
process.stdin.on('end', () => conn.end());
conn.on('close', () => process.exit(0));
conn.on('error', (error) => fail(`daemon connection lost: ${error.message}`));
