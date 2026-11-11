// A counting semaphore shared by every process on the machine that works on this repository: stories run
// in separate worker processes and worktrees, and together they may run at most `max` agents at once.
// Each held slot is a lock file `slot-<n>.lock` holding the owner's pid; a slot whose owner died is free.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';
import { isPidAlive, sleep } from '../../pipeline/lib/util.mjs';

// Under the git common dir, so the main checkout and all its worktrees share it.
export function semaphoreDir(root) {
  const r = git(root, ['rev-parse', '--git-common-dir']);
  const common = r.status === 0 ? path.resolve(root, r.stdout.trim()) : path.join(root, '.git');
  return path.join(common, 'pipeline-agent-slots');
}

function tryTake(dir, max, label) {
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 0; n < max; n++) {
    const file = path.join(dir, `slot-${n}.lock`);
    const token = randomUUID();
    const body = JSON.stringify({ pid: process.pid, token, label, ts: new Date().toISOString() });
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return { file, token };
    } catch {
      let holder;
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // half-written or just released; try again on the next pass
        continue;
      }
      if (holder && !isPidAlive(holder.pid)) {
        // Stale: its process died without releasing. Remove it only if it is still the same holder.
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).token === holder.token) {
            fs.unlinkSync(file);
            n--; // retry this slot
          }
        } catch {
          // someone else cleaned it up; the next pass sees it free
        }
      }
    }
  }
  return null;
}

// Waits for a free slot. Resolves to a release function, or null when `deadline` (epoch ms) passes first.
// `max` <= 0 disables the limit.
export async function acquire(dir, max, { deadline = Infinity, pollMs = 1000, label = '' } = {}) {
  if (!max || max <= 0) return () => {};
  for (;;) {
    const held = tryTake(dir, max, label);
    if (held) {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (JSON.parse(fs.readFileSync(held.file, 'utf8')).token === held.token) fs.unlinkSync(held.file);
        } catch {
          // already gone
        }
      };
    }
    if (Date.now() + pollMs > deadline) return null;
    await sleep(pollMs);
  }
}

export function holders(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.lock'))
    .flatMap((f) => {
      try {
        const h = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return isPidAlive(h.pid) ? [h] : [];
      } catch {
        return [];
      }
    });
}
