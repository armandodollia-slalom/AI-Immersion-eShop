#!/usr/bin/env node
// Node port of server.sh for Windows, which cannot exec a bash script. lspMcpConfig() (lib/daemon.mjs)
// picks it on win32; macOS and Linux keep server.sh. Same contract: starts one language server over
// stdio for the checkout in LSP_WORKSPACE_ROOT (set by lspd), else the checkout this script lives in;
// stdout is the LSP channel, so everything else goes to stderr.
//
// Usage: node scripts/lsp/server.mjs <csharp|typescript|bash|json|yaml|css|html>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = process.argv[2];
if (!name) {
  process.stderr.write('usage: server.mjs <language>\n');
  process.exit(2);
}

const root = process.env.LSP_WORKSPACE_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
env.PATH = [path.join(os.homedir(), '.dotnet'), path.join(os.homedir(), '.dotnet', 'tools'), env.PATH].join(path.delimiter);

// A git worktree without node_modules falls back to the main checkout's.
const commonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim();
const main = commonDir ? path.resolve(root, commonDir, '..') : root;

function nodeBin(bin) {
  for (const r of [root, main]) {
    for (const file of [`${bin}.cmd`, bin]) {
      const candidate = path.join(r, 'node_modules', '.bin', file);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  process.stderr.write(`lsp: ${bin} is not installed; run scripts/lsp/setup.sh\n`);
  process.exit(127);
}

function run(cmd, args) {
  // .cmd shims need a shell on Windows; quote every part because the checkout path may contain spaces.
  const shell = cmd.endsWith('.cmd');
  const child = shell
    ? spawn([cmd, ...args].map((a) => `"${a}"`).join(' '), { cwd: root, env, stdio: 'inherit', shell: true, windowsHide: true })
    : spawn(cmd, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

const servers = {
  typescript: ['typescript-language-server', ['--stdio']],
  bash: ['bash-language-server', ['start']],
  json: ['vscode-json-language-server', ['--stdio']],
  css: ['vscode-css-language-server', ['--stdio']],
  html: ['vscode-html-language-server', ['--stdio']],
  yaml: ['yaml-language-server', ['--stdio']],
};

if (name === 'csharp') {
  // Roslyn, pinned in .config/dotnet-tools.json. Restoring is a no-op once the package is cached.
  const restore = spawnSync('dotnet', ['tool', 'restore'], { cwd: root, env, stdio: ['ignore', 2, 2], windowsHide: true });
  if (restore.status !== 0) {
    process.stderr.write('lsp: dotnet tool restore failed\n');
    process.exit(1);
  }
  env.ESHOP_LSP_SOLUTION ??= path.join(root, 'eShop.slnx');
  run(process.execPath, [
    path.join(scriptsDir, 'roslyn-proxy.mjs'),
    'dotnet', 'tool', 'run', 'roslyn-language-server', '--stdio', '--telemetryLevel', 'off', '--logLevel', 'Warning',
  ]);
} else if (servers[name]) {
  const [bin, args] = servers[name];
  run(nodeBin(bin), args);
} else {
  process.stderr.write(`lsp: unknown language server '${name}'\n`);
  process.exit(2);
}
