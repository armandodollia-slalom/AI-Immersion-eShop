#!/usr/bin/env node
// lspd: per-checkout language-server daemon (see docs/code-intelligence.md).
//
//   node scripts/lsp/lspd.mjs start --worktree <path> [--slnf <file>]
//       -> {"ok":true,"pid":n,"socket":"...","csharp":"running|unavailable","reason":...}  (idempotent)
//   node scripts/lsp/lspd.mjs stop --worktree <path>
//   node scripts/lsp/lspd.mjs status [--worktree <path>]
//   node scripts/lsp/lspd.mjs stop-all
//   node scripts/lsp/lspd.mjs diagnostics --worktree <path> --files <f1> [<f2>...] [--no-start]
//       -> {"ok":true,"files":{"<f>":[{severity,line,col,code,message}] | {"unavailable":"<reason>"}}}
// --worktree defaults to the checkout containing the current directory. Every command prints one JSON line.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  control,
  daemonPaths,
  isMain,
  leaseDir,
  listLeases,
  loadConfig,
  pidAlive,
  readJson,
  realWorktree,
  runtimeDir,
  stateDir,
  worktreeOf,
} from './lib/common.mjs';

const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function daemonStatus(worktree, timeoutMs = 3000) {
  const paths = daemonPaths(worktree);
  try {
    return await control(paths.socket, { lspd: 'status' }, timeoutMs);
  } catch {
    return null;
  }
}

// Removes the socket/pid files of a daemon that is gone.
function clearStale(paths) {
  const info = readJson(paths.pidFile);
  if (info && pidAlive(info.pid)) return false;
  fs.rmSync(paths.socket, { force: true });
  fs.rmSync(paths.pidFile, { force: true });
  return true;
}

function takeLock(file) {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
    if (Number.isInteger(holder) && !pidAlive(holder)) {
      fs.rmSync(file, { force: true });
      return takeLock(file);
    }
    return false;
  }
}

// Starts the daemon for `worktree` unless one is already answering. Returns its status.
export async function ensureDaemon(worktree, { slnf, waitMs = 30000 } = {}) {
  worktree = realWorktree(worktree);
  const paths = daemonPaths(worktree);
  fs.mkdirSync(paths.dir, { recursive: true });
  const existing = await daemonStatus(worktree);
  if (existing) return existing;

  const deadline = Date.now() + waitMs;
  while (!takeLock(paths.lockFile)) {
    // Another process is starting it; wait for it to answer.
    const st = await daemonStatus(worktree, 1000);
    if (st) return st;
    if (Date.now() > deadline) throw new Error('timed out waiting for another lspd start');
    await sleep(200);
  }
  try {
    const again = await daemonStatus(worktree, 1000);
    if (again) return again;
    clearStale(paths);
    const log = fs.openSync(path.join(stateDir(worktree), 'lspd.log'), 'a');
    const args = [SELF, 'serve', '--worktree', worktree];
    if (slnf) args.push('--slnf', path.resolve(worktree, slnf));
    const child = spawn(process.execPath, args, { cwd: worktree, detached: true, stdio: ['ignore', log, log], env: process.env });
    child.unref();
    fs.closeSync(log);
    while (Date.now() < deadline) {
      await sleep(200);
      const st = await daemonStatus(worktree, 1000);
      if (st) return st;
      if (child.exitCode !== null) break;
    }
    const tail = fs.readFileSync(path.join(stateDir(worktree), 'lspd.log'), 'utf8').split('\n').slice(-6).join('\n');
    throw new Error(`lspd did not start for ${worktree}: ${tail.trim()}`);
  } finally {
    fs.rmSync(paths.lockFile, { force: true });
  }
}

export async function stopDaemon(worktree) {
  const paths = daemonPaths(worktree);
  const info = readJson(paths.pidFile);
  try {
    const res = await control(paths.socket, { lspd: 'stop' }, 5000);
    for (let i = 0; i < 50 && pidAlive(res.pid); i++) await sleep(100);
    return { ok: true, worktree, stopped: true, pid: res.pid };
  } catch {
    if (info && pidAlive(info.pid)) {
      process.kill(info.pid, 'SIGTERM');
      return { ok: true, worktree, stopped: true, pid: info.pid, forced: true };
    }
    clearStale(paths);
    return { ok: true, worktree, stopped: false, running: false };
  }
}

function knownDaemons() {
  const dir = runtimeDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^[0-9a-f]{12}\.json$/.test(f))
    .map((f) => readJson(path.join(dir, f)))
    .filter(Boolean);
}

export async function allStatus() {
  const daemons = [];
  for (const info of knownDaemons()) {
    const st = fs.existsSync(info.worktree) ? await daemonStatus(info.worktree, 2000) : null;
    if (st) daemons.push(st);
    else {
      if (fs.existsSync(info.worktree)) clearStale(daemonPaths(info.worktree));
      else if (!pidAlive(info.pid)) {
        fs.rmSync(info.socket, { force: true });
        fs.rmSync(path.join(runtimeDir(), `${path.basename(info.socket, '.sock')}.json`), { force: true });
      }
    }
  }
  const config = loadConfig();
  return { ok: true, daemons, leases: listLeases(leaseDir()), maxLanguageServers: config.maxLanguageServers };
}

function parseArgs(argv) {
  const opts = { cmd: argv[0], files: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--worktree') opts.worktree = argv[++i];
    else if (a === '--slnf') opts.slnf = argv[++i];
    else if (a === '--no-start') opts.noStart = true;
    else if (a === '--files') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.files.push(argv[++i]);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const worktree = () => realWorktree(opts.worktree ?? worktreeOf(process.cwd()));
  switch (opts.cmd) {
    case 'serve': {
      const { serve } = await import('./lib/daemon.mjs');
      await serve({ worktree: worktree(), slnf: opts.slnf });
      return undefined;
    }
    case 'start': {
      const st = await ensureDaemon(worktree(), { slnf: opts.slnf });
      return { ok: true, pid: st.pid, socket: st.socket, csharp: st.csharp, reason: st.reason, csharpState: st.csharpState, solution: st.solution, stateDir: st.stateDir };
    }
    case 'stop':
      return stopDaemon(worktree());
    case 'status':
      if (opts.worktree) return (await daemonStatus(worktree())) ?? { ok: true, running: false, worktree: worktree() };
      return allStatus();
    case 'stop-all': {
      const stopped = [];
      for (const info of knownDaemons()) {
        if (fs.existsSync(info.worktree)) stopped.push(await stopDaemon(info.worktree));
        else if (pidAlive(info.pid)) process.kill(info.pid, 'SIGTERM');
      }
      for (const l of listLeases(leaseDir())) if (!l.alive) fs.rmSync(l.file, { force: true });
      return { ok: true, stopped };
    }
    case 'diagnostics': {
      if (!opts.files.length) throw new Error('--files is required');
      const wt = worktree();
      const config = loadConfig();
      const st = opts.noStart ? await daemonStatus(wt) : await ensureDaemon(wt);
      if (!st) return { ok: true, files: Object.fromEntries(opts.files.map((f) => [f, { unavailable: 'lspd is not running' }])) };
      const timeoutMs = ((config.diagnosticsTimeoutSec ?? 20) * opts.files.length + 10) * 1000;
      // Relative paths are relative to --worktree when given, else to the current directory.
      const abs = opts.files.map((f) => path.resolve(opts.worktree ? wt : process.cwd(), f));
      const res = await control(daemonPaths(wt).socket, { lspd: 'diagnostics', files: abs }, timeoutMs);
      // Key the answer by the paths as the caller wrote them.
      if (res.files) res.files = Object.fromEntries(opts.files.map((f, i) => [f, res.files[abs[i]]]));
      return res;
    }
    default:
      throw new Error('usage: lspd.mjs start|stop|status|stop-all|diagnostics [--worktree <path>] [--slnf <file>] [--files ...]');
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (result) => {
      if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      process.exit(1);
    },
  );
}
