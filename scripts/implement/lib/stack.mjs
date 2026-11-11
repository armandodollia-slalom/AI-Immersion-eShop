// Adapter for the isolated app stack slots that UI verifiers run against. Everything the harness needs
// from the stack tooling goes through here, so a change in that tooling's contract is a change here only.
//
// Contract (scripts/stack/slots.mjs and testing/teststack):
//   node scripts/stack/slots.mjs lease --owner <id> [--wait-sec N] [--pid P]
//       -> stdout, one JSON line: {"ok":true,"slot":n,"webappUrl":"http://localhost:...","ports":{...},...}
//          exit 2 and {"ok":false,"error":"..."} when no slot is free in time. The lease belongs to --pid
//          (this process) and goes stale after 240 min or when that pid dies; `renew` extends it.
//   node scripts/stack/slots.mjs renew --slot <n> | release --slot <n>   (release does not stop the stack)
//   testing/teststack --slot <n> up | down | status | load <scenario> | rebuild-changed --base <ref>
//       run from the worktree under test: it builds that worktree's code. Image builds are serialized
//       machine-wide, so up/rebuild-changed may wait.
// The commands are `implement.ui.slotsCmd` and `implement.ui.teststackCmd` in the config.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { runAsync, sleep, tail } from '../../pipeline/lib/util.mjs';

// A relative script path in a command resolves against the given roots, first match wins.
function resolveCmd(cmd, roots) {
  const [head, ...rest] = cmd;
  const resolveArg = (a) => {
    if (!/[/\\]/.test(a) || path.isAbsolute(a)) return a;
    const hit = roots.map((r) => path.join(r, a)).find((f) => fs.existsSync(f));
    return hit ?? a;
  };
  return [resolveArg(head), ...rest.map(resolveArg)];
}

export function stackAdapter(config, { mainRoot = INSTALL_ROOT } = {}) {
  const ui = config.implement.ui;
  // Slots are a machine-wide registry: always use the main checkout's tool.
  const slots = (args, timeoutSec = 120) => {
    const [cmd, ...pre] = resolveCmd(ui.slotsCmd, [mainRoot, config.root]);
    return runAsync(cmd, [...pre, ...args], { cwd: mainRoot, timeoutSec });
  };

  return {
    // One lease attempt. { ok, slot, webappUrl, ports } or { ok: false, reason }.
    async lease(owner, waitSec = 0) {
      const r = await slots(['lease', '--owner', owner, '--pid', String(process.pid), ...(waitSec ? ['--wait-sec', String(waitSec)] : [])], waitSec + 120);
      const line = r.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
      try {
        const out = JSON.parse(line);
        if (out?.ok && out.slot != null && out.webappUrl) return out;
        return { ok: false, reason: out?.reason ?? out?.error ?? 'no free slot' };
      } catch {
        return { ok: false, reason: tail(`${r.stdout}\n${r.stderr}`.trim(), 500) || `slots lease exited ${r.status}` };
      }
    },

    // Leases a slot, retrying until `deadline` (epoch ms). Returns null when the deadline passes.
    async leaseUntil(owner, { deadline, waitSec = ui.leaseWaitSec, retrySec = ui.leaseRetrySec, log = () => {} }) {
      for (;;) {
        const left = Math.floor((deadline - Date.now()) / 1000);
        if (left <= 0) return null;
        const lease = await this.lease(owner, Math.max(0, Math.min(waitSec, left)));
        if (lease.ok) return lease;
        log(`no stack slot for ${owner} (${lease.reason}); retrying in ${retrySec}s`);
        if (Date.now() + retrySec * 1000 > deadline) return null;
        await sleep(retrySec * 1000);
      }
    },

    async renew(slot) {
      const r = await slots(['renew', '--slot', String(slot)]);
      return r.status === 0;
    },

    async release(slot) {
      const r = await slots(['release', '--slot', String(slot)]);
      return r.status === 0;
    },

    // testing/teststack --slot <n> ..., run from (and building) the given worktree.
    teststack(worktree, slot, args, timeoutSec = ui.stackTimeoutSec) {
      const [cmd, ...pre] = resolveCmd(ui.teststackCmd, [worktree]);
      return runAsync(cmd, [...pre, '--slot', String(slot), ...args], { cwd: worktree, timeoutSec });
    },
  };
}
