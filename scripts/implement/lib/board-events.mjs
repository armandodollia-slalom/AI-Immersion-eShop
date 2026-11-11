// The implement runner's pipeline events for the board stage (scripts/board/board.mjs): sync and claim
// when a run starts, Testing once the review approves and QE starts, back to In Progress on a product
// bug, Pending Review with the PR, Failed for any other outcome. The board is informational: a failure
// here is logged and never changes a story's outcome.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { boardDisabled } from '../../pipeline/lib/run-tags.mjs';
import { log, run } from '../../pipeline/lib/util.mjs';

const BOARD_CLI = path.join(INSTALL_ROOT, 'scripts/board/board.mjs');

export function board(root, args, { input = '' } = {}) {
  // Experiments (and anyone with PIPELINE_BOARD=0/off) leave the board alone: nothing is spawned.
  if (boardDisabled()) return { status: 0, stdout: '', stderr: '', skipped: true };
  if (!fs.existsSync(BOARD_CLI)) return { status: 0, stdout: '', stderr: '' };
  const env = { ...process.env, PIPELINE_ROOT: root };
  delete env.PIPELINE_CHILD;
  return run(process.execPath, [BOARD_CLI, ...args], { cwd: root, input, env, timeoutSec: 600 });
}

const lastLine = (r) => (r.skipped ? 'off (PIPELINE_BOARD)' : (r.status === 0 ? r.stdout : r.stderr).trim().split('\n').at(-1) || `exit ${r.status}`);

// Reports one event for a story from its worktree; logs the board's answer.
export function boardEvent(root, key, args, opts) {
  const r = board(root, args, opts);
  log(`${key}: board: ${lastLine(r)}`);
  return r;
}

export function syncBoard(root) {
  const r = board(root, ['sync']);
  log(`board: ${lastLine(r)}`);
}

// Claims the stories' cards for this machine. Returns key -> { status, owner, from }; only `refused`
// and `not-allowed` stop a story (another machine holds it, or its card is already in Pending Review or
// Done): --takeover takes a card another machine holds, --force runs a story in Pending Review or Done again.
export function claimStories(root, keys, { force = false, takeover = false } = {}) {
  if (!keys.length) return new Map();
  const r = board(root, ['claim', ...keys, '--json', ...(force ? ['--force'] : []), ...(takeover ? ['--takeover'] : [])]);
  const out = new Map();
  for (const line of r.stdout.split('\n')) {
    try {
      const o = JSON.parse(line);
      if (o?.key) out.set(o.key, o);
    } catch {
      // not a result line
    }
  }
  if (r.status !== 0) log(`board: claim failed: ${lastLine(r)}`);
  return out;
}

export const claimRefused = (claim) => claim && ['refused', 'not-allowed'].includes(claim.status);

// Marks every story whose claim was refused, and every story stacked on one, as skipped. Returns the
// keys skipped.
export function skipRefused(stories, claims, columns = {}) {
  const skipped = new Set();
  for (const s of stories) {
    if (s.skip) continue;
    const c = claims.get(s.key);
    if (claimRefused(c)) {
      s.skip = c.owner ? `claimed by ${c.owner} on the board (--takeover to take it over)` : `its card is in ${columns[c.from] ?? c.from} on the board (--force to run it again)`;
      skipped.add(s.key);
    } else if (s.deps?.some((k) => skipped.has(k))) {
      s.skip = `blocker ${s.deps.find((k) => skipped.has(k))} is not claimed by this machine`;
      skipped.add(s.key);
    }
  }
  return [...skipped];
}

// Stories of a finished batch that go to Failed: any outcome but done, a done story whose PR could not
// be opened, and stories skipped because a blocker failed (their cards were claimed).
export function failedResults(results, { pr = false } = {}) {
  return results.filter((r) => {
    if (r.outcome === 'done') return pr && !r.pr;
    if (r.outcome === 'skipped') return /^blocker .* ended /.test(r.reason ?? '');
    return Boolean(r.outcome);
  });
}
