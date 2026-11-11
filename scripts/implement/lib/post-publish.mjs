// After the runner publishes a fix PR (a single-ticket bug PR, or a bug-epic group PR), the review gate
// assesses it and decides how it gets merged (scripts/review-gate/, docs/ai-pipeline/review-gate.md).
// It runs as its own process from the PR's worktree, like the board events: a failure is logged and
// never changes a ticket's outcome. Feature PRs (stories, feature epics) are not gated.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { log, run } from '../../pipeline/lib/util.mjs';

const GATE_CLI = path.join(INSTALL_ROOT, 'scripts/review-gate/review-gate.mjs');

export function reviewGatePublish(worktree, { pr, keys, base, timeoutSec = 1800 }) {
  if (!pr || !keys?.length || !fs.existsSync(GATE_CLI)) return { status: 0, skipped: true };
  const env = { ...process.env, PIPELINE_ROOT: worktree };
  delete env.PIPELINE_CHILD;
  const r = run(process.execPath, [GATE_CLI, 'publish', '--pr', pr, '--tickets', keys.join(','), '--base', base], { cwd: worktree, env, timeoutSec });
  const last = (r.status === 0 ? r.stdout : r.stderr).trim().split('\n').at(-1) || `exit ${r.status}`;
  log(`${keys.join(', ')}: review gate: ${last}`);
  return r;
}
