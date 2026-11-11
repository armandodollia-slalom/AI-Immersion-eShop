// Shared helpers for the per-worktree language-server daemon (lspd): config, paths, sockets and the machine-wide
// lease that caps how many C# (Roslyn) servers run at once.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LSP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.resolve(LSP_DIR, '../..');

export function loadConfig(dir = process.env.LSP_CONFIG_DIR || LSP_DIR) {
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const max = Number.parseInt(process.env.LSP_MAX_SERVERS ?? '', 10);
  if (Number.isInteger(max) && max >= 0) config.maxLanguageServers = max;
  const idle = Number.parseInt(process.env.LSP_IDLE_SEC ?? '', 10);
  if (Number.isInteger(idle) && idle > 0) config.idleSec = idle;
  return config;
}

export const serverForFile = (config, file) => {
  const ext = path.extname(file).toLowerCase();
  return config.servers.find((s) => s.extensions.includes(ext)) ?? null;
};

// Runtime files shared by every checkout on the machine. Kept short: macOS caps unix socket paths at 104 bytes.
export const runtimeDir = () => process.env.LSP_RUNTIME_DIR ?? path.join(os.tmpdir(), 'eshop-lsp');
export const leaseDir = () => path.join(runtimeDir(), 'leases');

export const realWorktree = (worktree) => fs.realpathSync(path.resolve(worktree));
export const worktreeHash = (worktree) => createHash('sha256').update(realWorktree(worktree)).digest('hex').slice(0, 12);

// Windows has no unix domain sockets: Node serves IPC on named pipes there. A pipe is not a file
// and disappears with its server, so it is named after the runtime dir (keeping LSP_RUNTIME_DIR
// isolation) and never chmod-ed or deleted.
const isWindows = process.platform === 'win32';
const socketPath = (dir, hash) =>
  isWindows
    ? `\\\\.\\pipe\\eshop-lsp-${createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 8)}-${hash}`
    : path.join(dir, `${hash}.sock`);

export const removeSocket = (socket) => {
  if (!isWindows) fs.rmSync(socket, { force: true });
};

export const protectSocket = (socket) => {
  if (!isWindows) fs.chmodSync(socket, 0o600);
};

export function daemonPaths(worktree) {
  const hash = worktreeHash(worktree);
  const dir = runtimeDir();
  return {
    hash,
    dir,
    socket: socketPath(dir, hash),
    pidFile: path.join(dir, `${hash}.json`),
    lockFile: path.join(dir, `${hash}.lock`),
  };
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

// The checkout that owns `dir` (a worktree's own root, never the main checkout's).
export const worktreeOf = (dir = process.cwd()) => git(dir, ['rev-parse', '--show-toplevel']);

// Per-checkout state (logs, call log, C# status) lives in the checkout's git dir, outside the working tree:
// <main>/.git/lsp for the main checkout, <main>/.git/worktrees/<name>/lsp for a linked worktree.
export function stateDir(worktree) {
  const gitDir = path.resolve(worktree, git(worktree, ['rev-parse', '--git-dir']));
  const dir = path.join(gitDir, 'lsp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The main checkout, where node_modules usually lives when a fresh worktree has none.
export function mainCheckout(worktree) {
  try {
    return path.resolve(worktree, git(worktree, ['rev-parse', '--git-common-dir']), '..');
  } catch {
    return worktree;
  }
}

export function resolveNodeModule(worktree, rel) {
  for (const root of [worktree, mainCheckout(worktree), REPO_DIR]) {
    const file = path.join(root, 'node_modules', rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

export const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------------------------------------------
// Machine-wide lease: one file per slot, created with O_EXCL. A slot whose holder pid is dead is reclaimed by
// renaming it away first, so two processes recovering the same stale slot cannot both win.
// ---------------------------------------------------------------------------------------------------------------

export function acquireLease({ owner, pid = process.pid, max, dir = leaseDir() }) {
  fs.mkdirSync(dir, { recursive: true });
  for (let slot = 0; slot < max; slot++) {
    const file = path.join(dir, `slot-${slot}.json`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify({ slot, pid, owner, since: new Date().toISOString() }));
        fs.closeSync(fd);
        return { ok: true, slot, file };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const holder = readJson(file);
      if (holder && holder.pid === pid && holder.owner === owner) return { ok: true, slot, file };
      // A file being written right now has no JSON yet; only reclaim when the pid is known to be dead.
      if (!holder || pidAlive(holder.pid)) break;
      const grave = `${file}.stale.${process.pid}.${Date.now()}`;
      try {
        fs.renameSync(file, grave);
        fs.rmSync(grave, { force: true });
      } catch {
        break; // someone else reclaimed it first
      }
    }
  }
  const holders = listLeases(dir).map((l) => l.owner);
  return { ok: false, reason: `all ${max} C# language server slots are in use (${holders.join(', ') || 'none readable'})` };
}

export function releaseLease(lease) {
  if (!lease?.ok) return;
  const holder = readJson(lease.file);
  if (holder && holder.pid === process.pid) fs.rmSync(lease.file, { force: true });
}

export function listLeases(dir = leaseDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^slot-\d+\.json$/.test(f))
    .map((f) => ({ file: path.join(dir, f), ...(readJson(path.join(dir, f)) ?? {}) }))
    .map((l) => ({ ...l, alive: pidAlive(l.pid) }));
}

// ---------------------------------------------------------------------------------------------------------------
// Socket client: one JSON header line, then either a JSON reply (control) or an MCP stream.
// ---------------------------------------------------------------------------------------------------------------

export function connect(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    conn.once('connect', () => {
      clearTimeout(timer);
      resolve(conn);
    });
    conn.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function control(socket, header, timeoutMs = 5000) {
  const conn = await connect(socket, Math.min(timeoutMs, 2000));
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`no answer from lspd within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        conn.end();
        try {
          resolve(JSON.parse(buffer.slice(0, nl)));
        } catch (error) {
          reject(error);
        }
      }
    });
    conn.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    conn.write(`${JSON.stringify(header)}\n`);
  });
}

// True when the module at `metaUrl` is the script node was started with.
export const isMain = (metaUrl) => {
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};
