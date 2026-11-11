// Machine-wide leases on test-stack slots. Slot 0 is never leased (it belongs to people and the existing QE
// flows); slots 1..poolSize are handed out to agents. State lives outside any worktree, in
// $TESTSTACK_STATE_HOME (default ~/.eshop-teststack), because leases are taken from different worktrees and
// host ports are machine-wide.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, slotInfo } from './ports.mjs';

const MUTEX_STALE_MS = 15_000;
const UNWRITTEN_GRACE_MS = 30_000;

export function stateHome(env = process.env) {
  return env.TESTSTACK_STATE_HOME || path.join(os.homedir(), '.eshop-teststack');
}

export function poolSize(config = loadConfig(), env = process.env) {
  const raw = env.TESTSTACK_SLOTS;
  const size = raw === undefined || raw === '' ? config.poolSize : Number(raw);
  if (!Number.isInteger(size) || size < 0) throw new Error(`TESTSTACK_SLOTS must be a non-negative integer, got '${raw}'`);
  return Math.min(size, config.maxSlot);
}

const leasesDir = home => path.join(home, 'leases');
const leaseFile = (home, slot) => path.join(leasesDir(home), `slot-${slot}.json`);

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Why a lease is stale (owner process gone, or older than the TTL), or null while it is live. */
export function staleReason(lease, { now = Date.now(), ttlMs, isAlive = isPidAlive, hostname = os.hostname() } = {}) {
  if (!lease) return null;
  if (lease.unreadable) return lease.ageMs > UNWRITTEN_GRACE_MS ? 'unreadable lease file' : null;
  const age = now - Date.parse(lease.renewedAt ?? lease.createdAt);
  if (!(age <= ttlMs)) return `older than ${Math.round(ttlMs / 60000)} min`;
  if (lease.pid && (!lease.hostname || lease.hostname === hostname) && !isAlive(lease.pid)) return `owner pid ${lease.pid} is gone`;
  return null;
}

function readLease(home, slot, now) {
  const file = leaseFile(home, slot);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    let ageMs;
    try { ageMs = now - fs.statSync(file).mtimeMs; } catch { return null; }
    return { slot, unreadable: true, ageMs };
  }
}

// Short machine-wide critical section (mkdir is atomic) so scanning, recovering and claiming never race.
async function withMutex(home, fn, { timeoutMs = 30_000 } = {}) {
  const dir = path.join(leasesDir(home), '.mutex');
  fs.mkdirSync(leasesDir(home), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > MUTEX_STALE_MS) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* removed by its holder meanwhile */ }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the lease mutex ${dir}`, { cause: error });
      await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function options(opts) {
  const config = opts.config ?? loadConfig();
  return {
    config,
    home: opts.home ?? stateHome(),
    pool: opts.pool ?? poolSize(config),
    ttlMs: opts.ttlMs ?? config.leaseTtlMinutes * 60_000,
    now: opts.now ?? (() => Date.now()),
    isAlive: opts.isAlive ?? isPidAlive,
  };
}

/** Every pool slot with its lease (or null) and whether that lease is stale. */
export function listLeases(opts = {}) {
  const { config, home, pool, ttlMs, now, isAlive } = options(opts);
  const t = now();
  return Array.from({ length: pool }, (_, i) => {
    const slot = i + 1;
    const lease = readLease(home, slot, t);
    const stale = staleReason(lease, { now: t, ttlMs, isAlive });
    const { webappUrl, project } = slotInfo(slot, config);
    return { slot, free: !lease || Boolean(stale), project, webappUrl, lease, stale };
  });
}

/** One attempt to claim a free slot (recovering stale leases); returns the slot info or null when all are taken. */
export async function tryLease(owner, opts = {}) {
  if (!owner) throw new Error('lease requires an owner');
  const { config, home, pool, ttlMs, now, isAlive } = options(opts);
  return withMutex(home, () => {
    const t = now();
    for (let slot = 1; slot <= pool; slot++) {
      const existing = readLease(home, slot, t);
      const stale = staleReason(existing, { now: t, ttlMs, isAlive });
      if (existing && !stale) continue;
      if (existing) {
        process.stderr.write(`[slots] recovering stale lease on slot ${slot} (${existing.owner ?? 'unknown owner'}: ${stale})\n`);
        fs.rmSync(leaseFile(home, slot), { force: true });
      }
      const lease = {
        slot,
        owner,
        pid: opts.pid ?? process.pid,
        hostname: os.hostname(),
        cwd: opts.cwd ?? process.cwd(),
        createdAt: new Date(t).toISOString(),
      };
      let fd;
      try {
        fd = fs.openSync(leaseFile(home, slot), 'wx');
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      try { fs.writeFileSync(fd, `${JSON.stringify(lease, null, 2)}\n`); } finally { fs.closeSync(fd); }
      return { ...slotInfo(slot, config), lease, recovered: existing ? stale : undefined };
    }
    return null;
  });
}

/** Claims a slot, polling every pollMs for up to waitSec seconds. Returns the slot info or null. */
export async function lease(owner, opts = {}) {
  const waitMs = (opts.waitSec ?? 0) * 1000;
  const pollMs = opts.pollMs ?? 2000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const claimed = await tryLease(owner, opts);
    if (claimed || Date.now() >= deadline) return claimed;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

/** Frees a slot. With an owner, only that owner's lease is released (unless force). Returns the old lease. */
export async function release(slot, opts = {}) {
  const { home, now } = options(opts);
  return withMutex(home, () => {
    const existing = readLease(home, slot, now());
    if (!existing) return null;
    if (opts.owner && existing.owner !== opts.owner && !opts.force) {
      throw new Error(`slot ${slot} is leased by '${existing.owner}', not '${opts.owner}'`);
    }
    fs.rmSync(leaseFile(home, slot), { force: true });
    return existing;
  });
}

/** Refreshes a lease's TTL (and optionally its owner pid). */
export async function renew(slot, opts = {}) {
  const { home, now } = options(opts);
  return withMutex(home, () => {
    const existing = readLease(home, slot, now());
    if (!existing || existing.unreadable) throw new Error(`slot ${slot} is not leased`);
    if (opts.owner && existing.owner !== opts.owner) throw new Error(`slot ${slot} is leased by '${existing.owner}', not '${opts.owner}'`);
    const updated = { ...existing, renewedAt: new Date(now()).toISOString(), ...(opts.pid ? { pid: opts.pid } : {}) };
    fs.writeFileSync(leaseFile(home, slot), `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
  });
}

/**
 * Best-effort warning when Docker's memory looks too small for one more stack (running test stacks counted at
 * config.stackMemoryMb each). Returns a message or null; never throws.
 */
export function memoryWarning({ config = loadConfig(), docker = process.env.TESTSTACK_DOCKER || 'docker' } = {}) {
  try {
    const info = spawnSync(docker, ['info', '--format', '{{.MemTotal}}'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const totalMb = Number(info.stdout.trim()) / 1024 / 1024;
    if (info.status !== 0 || !totalMb) return null;
    const ls = spawnSync(docker, ['compose', 'ls', '--format', 'json'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const running = ls.status === 0
      ? JSON.parse(ls.stdout || '[]').filter(p => p.Name?.startsWith(config.project) && /running/.test(p.Status ?? '')).length
      : 0;
    const neededMb = (running + 1) * config.stackMemoryMb;
    if (neededMb <= totalMb * 0.9) return null;
    return `Docker has ${Math.round(totalMb)} MB; ${running} test stack(s) are running and another needs about ${config.stackMemoryMb} MB`;
  } catch {
    return null;
  }
}
