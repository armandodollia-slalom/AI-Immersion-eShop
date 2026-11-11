// Stack slots for the QE stage's e2e runs. On slot 0 every story's specs take turns behind one
// machine-wide lock. When `implement run` works on several tickets at once (IMPLEMENT_PARALLEL > 1) and
// `qe.useSlots` is on (the default), a story's run leases an isolated slot instead (scripts/stack/
// slots.mjs), brings that slot's stack up from the story's worktree, runs its specs with TESTSTACK_SLOT
// and TESTSTACK_URL pointing at it, and tears it down. Specs with hard-coded slot-0 ports (18xxx) stay on
// slot 0, and so does a run that finds no free slot. See docs/ai-pipeline/qe.md#stack-slots.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { log, run, runAsync } from '../../pipeline/lib/util.mjs';

// A spec runs on any slot unless it names a slot-0 host port (18000-18999) literally; e2e/teststack/
// ports.ts builds the URLs from TESTSTACK_SLOT instead.
const SLOT0_PORT = /(?:localhost|127\.0\.0\.1|host\.docker\.internal):18\d{3}\b/;
export const slotAware = (texts) => texts.every((t) => !SLOT0_PORT.test(t));

export function wantsSlot(config, env = process.env) {
  if (config.useSlots === false || env.QE_USE_SLOTS === '0') return false;
  return Number(env.IMPLEMENT_PARALLEL ?? 1) > 1 || env.QE_USE_SLOTS === '1';
}

const slotsCli = () => path.join(INSTALL_ROOT, 'scripts/stack/slots.mjs');

export const defaultSlotDeps = {
  lease: (owner) => {
    const r = run(process.execPath, [slotsCli(), 'lease', '--owner', owner, '--pid', String(process.pid)], { cwd: INSTALL_ROOT, timeoutSec: 120 });
    try {
      const out = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '');
      return out?.ok ? out : null;
    } catch {
      return null;
    }
  },
  release: (slot) => run(process.execPath, [slotsCli(), 'release', '--slot', String(slot)], { cwd: INSTALL_ROOT, timeoutSec: 120 }),
  teststack: (root, slot, args, timeoutSec) => runAsync(path.join(root, 'testing/teststack'), ['--slot', String(slot), ...args], { cwd: root, timeoutSec }),
};

// Runs `fn(env)` on a leased slot when the story's specs allow it, else returns null so the caller uses
// the slot-0 lock. `fn` gets the environment for the test command (TESTSTACK_SLOT, TESTSTACK_URL).
export async function onLeasedSlot(config, { key, specFiles, timeoutSec }, fn, deps = defaultSlotDeps) {
  if (!wantsSlot(config)) return null;
  const texts = specFiles.map((f) => {
    try {
      return fs.readFileSync(path.join(config.root, f), 'utf8');
    } catch {
      return '';
    }
  });
  if (!slotAware(texts)) {
    log(`${key}: specs use slot-0 ports; running them on slot 0`);
    return null;
  }
  const lease = deps.lease(`qe-${key}`);
  if (!lease) {
    log(`${key}: no free stack slot; running the specs on slot 0`);
    return null;
  }
  try {
    const up = await deps.teststack(config.root, lease.slot, ['up'], timeoutSec);
    if (up.status !== 0) {
      log(`${key}: slot ${lease.slot} did not come up (exit ${up.status}); running the specs on slot 0`);
      return null;
    }
    log(`${key}: running the specs on stack slot ${lease.slot} (${lease.webappUrl})`);
    return await fn({ TESTSTACK_SLOT: String(lease.slot), TESTSTACK_URL: lease.webappUrl });
  } finally {
    await deps.teststack(config.root, lease.slot, ['down'], timeoutSec);
    deps.release(lease.slot);
  }
}
