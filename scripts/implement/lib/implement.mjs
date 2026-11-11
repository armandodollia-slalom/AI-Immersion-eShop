import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runAgent } from '../../pipeline/lib/agents.mjs';
import { INSTALL_ROOT, loadConfig } from '../../pipeline/lib/config.mjs';
import { formatBugs } from '../../pipeline/lib/decisions.mjs';
import { git, implChanges, revExists } from '../../pipeline/lib/git.mjs';
import { loadState, metricsFile } from '../../pipeline/lib/state.mjs';
import { activeStoryFile } from '../../pipeline/lib/stories.mjs';
import { appendJsonl, extractResult, isProcessAlive, log, nowIso, readJson, run, sleep, tail, writeJson } from '../../pipeline/lib/util.mjs';
import { branchFor, collectStories, orderStories, worktreeFor } from './batch.mjs';

const PIPELINE_CLI = path.join(INSTALL_ROOT, 'scripts/pipeline/pipeline.mjs');
const QE_TERMINAL = new Set(['verified', 'product-bug', 'escalated', 'blocked-on-plan', 'crashed', 'interrupted']);
// Outcomes from a run that died rather than finished: the next run resumes them, and the batch retries
// them itself a few times.
const INTERRUPTED = new Set(['error', 'qe-crashed', 'qe-not-started', 'qe-timed-out']);
const RETRYABLE = new Set(['error', 'qe-not-started']);

export const runsDir = (config) => path.join(config.root, config.stateDir, 'implement');
const runFile = (config, key) => path.join(runsDir(config), `${key}.json`);
export const loadRun = (config, key) => readJson(runFile(config, key), null);
export const batchFile = (config) => path.join(runsDir(config), 'batch.json');
const saveRun = (config, key, patch) => writeJson(runFile(config, key), { ...(loadRun(config, key) ?? {}), key, ...patch, updatedAt: nowIso() });

// ---------------------------------------------------------------------------------------------
// Batch: order the stories, then run one worker process per story, at most `parallel` at a time
// ---------------------------------------------------------------------------------------------

export function plan(config, inputs, { base = config.baseRef, force = false } = {}) {
  const stories = orderStories(collectStories(inputs));
  const byKey = new Map(stories.map((s) => [s.key, s]));
  for (const s of stories) {
    s.skip = s.implemented && !force ? 'already implemented (has "## Implementation Notes"; --force to redo)' : null;
    // A later run continues where an interrupted one stopped: finished stories are kept, stories that
    // died part-way resume in their worktree.
    const prev = force || s.skip ? null : loadRun(config, s.key);
    if (prev?.outcome === 'done' && prev.branch && revExists(config.root, `refs/heads/${prev.branch}`)) {
      s.skip = `done in a previous run (--force to redo)`;
      s.doneBefore = true;
    }
    s.resume = Boolean(prev && !s.doneBefore && (prev.status === 'running' || INTERRUPTED.has(prev.outcome)) && prev.worktree && fs.existsSync(prev.worktree));
  }
  // Blockers already implemented are on the base branch, so only the ones built in this run (or kept
  // from an earlier one, still on their branch) count.
  const ancestors = new Map();
  for (const s of stories) {
    s.deps = s.deps.filter((k) => !byKey.get(k).skip || byKey.get(k).doneBefore);
    ancestors.set(s.key, new Set(s.deps.flatMap((k) => [k, ...ancestors.get(k)])));
  }
  for (const s of stories) {
    s.branch = branchFor(config, s);
    s.worktree = worktreeFor(config, s);
    // A story stacks on the branch of the in-batch blocker that already contains the most of its other
    // blockers, and merges in whatever that branch lacks, so it builds on all the code it needs.
    const deps = s.deps.filter((k) => !s.deps.some((o) => o !== k && ancestors.get(o).has(k)));
    deps.sort((a, b) => ancestors.get(b).size - ancestors.get(a).size);
    s.base = deps.length ? byKey.get(deps[0]).branch : base;
    s.merge = deps.slice(1).map((k) => byKey.get(k).branch);
  }
  return stories;
}

export function describePlan(stories) {
  return stories
    .map((s, i) => `${String(i + 1).padStart(2)}. ${s.key.padEnd(10)} ${s.skip ? `skip: ${s.skip}` : `${s.branch} <- ${s.base}${s.merge.length ? ` + ${s.merge.join(', ')}` : ''}${s.resume ? '  (resume)' : ''}`}${s.blockedBy.length ? `  (blocked by ${s.blockedBy.join(', ')})` : ''}`)
    .join('\n');
}

export async function runBatch(config, stories, { parallel = 1, pr = false, script }) {
  fs.mkdirSync(runsDir(config), { recursive: true });
  const outcome = new Map(stories.filter((s) => s.skip).map((s) => [s.key, { outcome: 'skipped', reason: s.skip }]));
  for (const s of stories) {
    if (s.doneBefore) continue;
    saveRun(config, s.key, s.skip ? { outcome: 'skipped', reason: s.skip, status: 'finished' } : { status: 'queued', outcome: null, reason: null, branch: s.branch, worktree: s.worktree, base: s.base });
  }
  const retries = new Map();
  const { maxWorkerRetries = 0, retryDelaySec = 0 } = config.implement;

  const pending = stories.filter((s) => !s.skip);
  const running = new Map();
  const blockerFailed = (s) => s.deps.find((k) => outcome.has(k) && !['done', 'skipped'].includes(outcome.get(k).outcome));
  const ready = (s) => s.deps.every((k) => ['done', 'skipped'].includes(outcome.get(k)?.outcome));

  while (pending.length || running.size) {
    for (let i = 0; i < pending.length; i++) {
      const s = pending[i];
      const failed = blockerFailed(s);
      if (failed) {
        pending.splice(i--, 1);
        const result = { outcome: 'skipped', reason: `blocker ${failed} ended ${outcome.get(failed).outcome}` };
        outcome.set(s.key, result);
        saveRun(config, s.key, { ...result, status: 'finished' });
        log(`${s.key}: ${result.reason}; skipped.`);
      } else if (running.size < parallel && ready(s)) {
        pending.splice(i--, 1);
        running.set(s.key, startWorker(config, s, { pr, script }).then((r) => [s, r]));
      }
    }
    if (!running.size) continue;
    const [s, result] = await Promise.race(running.values());
    running.delete(s.key);
    const attempt = (retries.get(s.key) ?? 0) + 1;
    if (RETRYABLE.has(result.outcome) && attempt <= maxWorkerRetries) {
      retries.set(s.key, attempt);
      s.resume = true;
      log(`${s.key}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}; retrying (${attempt}/${maxWorkerRetries}).`);
      running.set(s.key, sleep(retryDelaySec * 1000 * attempt).then(() => startWorker(config, s, { pr, script })).then((r) => [s, r]));
      continue;
    }
    outcome.set(s.key, result);
    log(`${s.key}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
  }
  return stories.map((s) => ({ ...s, ...outcome.get(s.key) }));
}

function startWorker(config, story, { pr, script }) {
  const resultFile = path.join(runsDir(config), `${story.key}.result.json`);
  const logPath = path.join(config.root, config.stateDir, 'logs', `implement-${story.key}-${nowIso().replace(/[:.]/g, '-')}.log`);
  fs.rmSync(resultFile, { force: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const args = ['story', story.key, '--file', story.file, '--base', story.base, '--branch', story.branch, '--worktree', story.worktree, '--result', resultFile];
  if (story.merge.length) args.push('--merge', story.merge.join(','));
  if (pr) args.push('--pr');
  if (story.resume) args.push('--resume');
  saveRun(config, story.key, { status: 'running', outcome: null, reason: null, startedAt: nowIso(), log: path.relative(config.root, logPath) });
  log(`${story.key}: started on ${story.branch} (log: ${path.relative(config.root, logPath)})`);
  const fd = fs.openSync(logPath, 'a');
  const env = { ...process.env };
  delete env.PIPELINE_ROOT;
  const child = spawn(process.execPath, [script, ...args], { cwd: config.root, stdio: ['ignore', fd, fd], env });
  fs.closeSync(fd);
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      const result = readJson(resultFile, null) ?? { outcome: 'error', reason: `worker exited ${code} without a result; see ${path.relative(config.root, logPath)}` };
      saveRun(config, story.key, { ...result, status: 'finished', finishedAt: nowIso() });
      resolve(result);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Worker: one story, start to finish, in its own worktree
// ---------------------------------------------------------------------------------------------

const commitEnv = { ...process.env, PIPELINE_DISABLE: '1' };
const mustGit = (cwd, args) => git(cwd, args, { allowFail: false, env: commitEnv });

function commitAll(cwd, message, specs = ['.', ':!graphify-out']) {
  git(cwd, ['add', '-A', '--', ...specs], { env: commitEnv });
  if (git(cwd, ['diff', '--cached', '--quiet']).status === 0) return false;
  mustGit(cwd, ['commit', '-q', '-m', message]);
  return true;
}

export function prepareWorktree(config, { key, file, base, branch, worktree, merge = [] }) {
  if (!fs.existsSync(worktree)) {
    if (!revExists(config.root, base)) throw new Error(`base ${base} does not exist`);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    const exists = revExists(config.root, `refs/heads/${branch}`);
    mustGit(config.root, ['worktree', 'add', '-q', ...(exists ? [worktree, branch] : ['-b', branch, worktree, base])]);
    log(`${key}: worktree ${worktree} on ${branch}${exists ? ' (existing branch)' : ` from ${base}`}`);
  } else {
    log(`${key}: reusing worktree ${worktree}`);
  }
  for (const other of merge) {
    const r = git(worktree, ['merge', '--no-edit', '-q', other], { env: commitEnv });
    if (r.status !== 0) {
      git(worktree, ['merge', '--abort']);
      return { error: `merging ${other} conflicts; resolve it by hand in ${worktree}` };
    }
  }
  // The story lives on the feature branch, so the review and QE stages (and the PR) see the same text.
  const wtConfig = loadConfig('implement', worktree);
  const storiesDir = wtConfig.abs(wtConfig.storiesDir);
  const target = path.join(storiesDir, path.basename(file));
  const text = fs.readFileSync(file, 'utf8');
  if (path.resolve(file) !== target && (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text)) {
    fs.mkdirSync(storiesDir, { recursive: true });
    for (const f of fs.readdirSync(storiesDir)) if (f.startsWith(`${key}-`) && f !== path.basename(file)) fs.rmSync(path.join(storiesDir, f));
    fs.writeFileSync(target, text);
    commitAll(worktree, `${key}: Add story`, [path.relative(worktree, storiesDir)]);
  }
  return { config: wtConfig, story: target };
}

function pipeline(worktree, base, args, input = '') {
  const env = { ...process.env, PIPELINE_ROOT: worktree, PIPELINE_BASE_REF: base };
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  return run(process.execPath, [PIPELINE_CLI, ...args], { cwd: worktree, input, env });
}

function implementerTask({ key, storyFile, branch, worktree, base, feedback }) {
  const lines = [
    `Implement story ${key}: ${path.relative(worktree, storyFile)}`,
    '',
    'You are running headless under `pipeline implement`. These instructions override steps 1 and 7 of your workflow:',
    `- The worktree (${worktree}) and branch (${branch}, based on ${base}) already exist and are your working directory. Do not create worktrees, switch branches, push, or open a PR.`,
    '- The pipeline has already been started for this story. Do not run `pipeline start` or `pipeline done`; the runner does that.',
    '- Commit your work with clear messages when you finish. Anything left uncommitted is committed for you.',
    '- Nobody can answer questions. If an Open Question or missing blocker makes the story unimplementable, stop and report `blocked`. Otherwise make a reasonable, documented choice and continue.',
    '',
    'End your reply with exactly one line:',
    'AGENT_RESULT: {"status": "done" | "blocked" | "partial", "reason": "<one sentence>"}',
  ];
  if (feedback) lines.push('', 'Address this feedback, then finish again:', '', feedback);
  return lines.join('\n');
}

// A QE run that dies is handed to the QE stage's own recovery (`pipeline resume`), which resumes it from
// its last round, backs off, and gives up as "crashed" after a few attempts.
async function waitForQe(config, key, { timeoutSec, pollSec, recover }) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSec * 1000;
  let nextRecover = 0;
  for (;;) {
    const a = loadState(config, key).automation;
    if (QE_TERMINAL.has(a.status) && !a.requestedHash) return a;
    const dead = (a.status === 'running' && !isProcessAlive(a.pid, a.boot)) || (a.status === 'starting' && Date.now() - Date.parse(a.requestedAt ?? 0) > config.recovery.startingGraceSec * 1000);
    if (dead && Date.now() >= nextRecover) {
      recover();
      nextRecover = Date.now() + Math.max(pollSec * 1000, 10_000);
    }
    if (a.status === 'idle' && Date.now() - startedAt > 30_000) return { ...a, status: 'not-started' };
    if (Date.now() > deadline) return { ...a, status: 'timed-out' };
    await sleep(pollSec * 1000);
  }
}

export async function implementStory(config, opts) {
  const { key, base, branch, worktree, pr } = opts;
  const settings = config.implement;
  const started = Date.now();
  const metrics = { implementerRuns: 0, reviewBlocks: 0, bugFixCycles: 0, promptVersion: null };
  const finish = (outcome, reason = null, extra = {}) => ({ key, outcome, reason, branch, worktree, base, minutes: Math.round((Date.now() - started) / 600) / 100, ...metrics, ...extra });

  const prep = prepareWorktree(config, opts);
  if (prep.error) return finish('blocked', prep.error);
  const wt = prep.config;
  // Resuming a story whose review already approved the code on disk goes straight to QE; otherwise the
  // implementer continues from the work left in the worktree.
  const prior = opts.resume ? loadState(wt, key) : null;
  const hash = prior ? implChanges(wt).hash : null;
  let skipImplementer = Boolean(hash && prior.done && prior.review.lastVerdict === 'APPROVED' && prior.review.approvedHash === hash);
  let feedback = null;
  if (skipImplementer) {
    log(`${key}: resuming after the approved review; (re)starting QE.`);
    pipeline(worktree, base, ['hook', 'stop'], '{}');
  } else {
    // A resumed story that was already started keeps its review rounds and stage state; `start` would reset them.
    const alreadyStarted = Boolean(prior) && path.basename(activeStoryFile(wt) ?? '').startsWith(`${key}-`);
    if (!alreadyStarted) {
      const start = pipeline(worktree, base, ['start', key]);
      if (start.status !== 0) return finish('error', `pipeline start failed: ${tail(start.stderr, 500)}`);
    }
    if (opts.resume) feedback = 'A previous run of this story was interrupted. Its work so far is on this branch (committed, or still uncommitted in the worktree). Review it and continue the implementation rather than starting over.';
  }

  let qe;
  for (;;) {
    // Implementation and review loop: the review's stop hook blocks with findings until it approves.
    let approved = skipImplementer;
    skipImplementer = false;
    while (!approved) {
      if (metrics.implementerRuns >= settings.maxImplementerRuns) return finish('unresolved', `still not approved after ${metrics.implementerRuns} implementer runs`);
      metrics.implementerRuns++;
      const res = runAgent(wt, {
        name: 'implementer',
        task: implementerTask({ key, storyFile: prep.story, branch, worktree, base, feedback }),
        mode: 'implement',
        model: wt.agent.models.implementer,
        timeoutSec: settings.implementerTimeoutSec,
        usage: { stage: 'implement', story: key, round: metrics.implementerRuns },
      });
      metrics.promptVersion = res.version;
      const reported = extractResult(res.output);
      commitAll(worktree, `${key}: Implementation`);
      if (reported?.status === 'blocked') return finish('blocked', reported.reason ?? 'the implementer reported the story blocked');
      if (!res.ok && !reported) {
        feedback = `The previous run ${res.timedOut ? 'timed out' : `failed (exit ${res.status})`} before finishing. Continue the implementation.`;
        continue;
      }
      const done = pipeline(worktree, base, ['done', key]);
      if (/\(0 implementation file/.test(done.stdout)) return finish('no-changes', reported?.reason ?? 'the implementer changed no implementation files');
      const stop = pipeline(worktree, base, ['hook', 'stop'], '{}');
      let output;
      try {
        output = stop.stdout.trim() ? JSON.parse(stop.stdout) : null;
      } catch {
        output = null;
      }
      if (output?.decision === 'block') {
        metrics.reviewBlocks++;
        feedback = output.reason;
        continue;
      }
      const review = loadState(wt, key).review;
      if (review.lastVerdict === 'ESCALATED') return finish('review-escalated', review.lastReason ?? 'the review did not converge');
      if (review.lastVerdict !== 'APPROVED') return finish('unresolved', output?.systemMessage ?? `review verdict ${review.lastVerdict ?? 'none'}`);
      approved = true;
    }

    // QE writes and verifies the tests in the background; wait for its verdict.
    qe = await waitForQe(wt, key, { timeoutSec: settings.qeTimeoutSec, pollSec: settings.qePollSec, recover: () => pipeline(worktree, base, ['resume', key]) });
    if (qe.status !== 'product-bug') break;
    if (metrics.bugFixCycles >= settings.maxBugFixCycles) break;
    metrics.bugFixCycles++;
    feedback = `The automated tests found implementation bugs. Fix the implementation (not the tests):\n${formatBugs(qe.bugs)}`;
  }

  const outcome = qe.status === 'verified' ? 'done' : `qe-${qe.status}`;
  const result = finish(outcome, outcome === 'done' ? null : `QE ended ${qe.status}${qe.bugs?.length ? `: ${qe.bugs.length} bug(s)` : ''}`);
  appendJsonl(metricsFile(wt, 'implement-runs.jsonl'), [{ ts: nowIso(), story: key, outcome, implementer_runs: metrics.implementerRuns, review_blocks: metrics.reviewBlocks, bug_fix_cycles: metrics.bugFixCycles, minutes: result.minutes, prompt_version: metrics.promptVersion }]);
  commitAll(worktree, `${key}: Add verified test plan and automated tests`);

  if (pr && outcome === 'done') {
    const push = git(worktree, ['push', '-u', 'origin', branch]);
    if (push.status !== 0) return { ...result, reason: `push failed: ${tail(push.stderr, 300)}` };
    const baseBranch = base.replace(/^origin\//, '');
    const title = `${key}: ${fs.readFileSync(prep.story, 'utf8').match(/^#\s+(.+)$/m)?.[1]?.replace(new RegExp(`^${key}[:\\s-]*`), '') ?? key}`;
    const body = `Implements ${path.relative(worktree, prep.story)} (generated by \`pipeline implement\`).\n\n- Architecture review: approved\n- Test plan and automated tests: verified\n- Implementer runs: ${metrics.implementerRuns}, review rounds blocked: ${metrics.reviewBlocks}, QE bug-fix cycles: ${metrics.bugFixCycles}\n\nThe demo video of the changed e2e specs (and, for backend changes, an API summary of the endpoints) is added below by the PR demo video workflow once it has recorded them.`;
    const created = run('gh', ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', title, '--body', body], { cwd: worktree });
    return { ...result, pr: created.status === 0 ? created.stdout.trim() : null, ...(created.status !== 0 ? { reason: `gh pr create failed: ${tail(created.stderr, 300)}` } : {}) };
  }
  return result;
}

export function formatSummary(results) {
  const rows = results.map((r) => `${r.key.padEnd(10)} ${String(r.outcome ?? '-').padEnd(18)} ${r.branch ?? ''}${r.pr ? `  ${r.pr}` : ''}${r.reason ? `\n${' '.repeat(11)}${r.reason}` : ''}`);
  return `${'Story'.padEnd(10)} ${'Outcome'.padEnd(18)} Branch\n${rows.join('\n')}`;
}
