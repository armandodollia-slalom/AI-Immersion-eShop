import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runAgent } from '../../pipeline/lib/agents.mjs';
import { INSTALL_ROOT, loadConfig } from '../../pipeline/lib/config.mjs';
import { git, revExists } from '../../pipeline/lib/git.mjs';
import { loadState, metricsFile } from '../../pipeline/lib/state.mjs';
import { appendJsonl, extractResult, isPidAlive, log, nowIso, readJson, readJsonl, run, sleep, tail, writeJson } from '../../pipeline/lib/util.mjs';
import { branchFor, collectStories, orderStories, worktreeFor } from './batch.mjs';
import { OUTCOMES_FILE, attributeEscaped, storyOutcomeRecord } from './decisions.mjs';
import { commitAll, commitEnv, filesChanged, headSha, mustGit } from './gitops.mjs';
import { formatDiagnostics } from './lsp.mjs';
import { LimitError, agentSettings, checkBudget, createContext, orchestrate } from './orchestrate.mjs';
import { integrationTask } from './tasks.mjs';

const PIPELINE_CLI = path.join(INSTALL_ROOT, 'scripts/pipeline/pipeline.mjs');
const BOARD_CLI = path.join(INSTALL_ROOT, 'scripts/board/board.mjs');
const QE_TERMINAL = new Set(['verified', 'product-bug', 'escalated', 'blocked-on-plan']);

export const runsDir = (config) => path.join(config.root, config.stateDir, 'implement');
const runFile = (config, key) => path.join(runsDir(config), `${key}.json`);
export const loadRun = (config, key) => readJson(runFile(config, key), null);
const saveRun = (config, key, patch) => writeJson(runFile(config, key), { ...(loadRun(config, key) ?? {}), key, ...patch, updatedAt: nowIso() });

// ---------------------------------------------------------------------------------------------
// Batch: order the stories, then run one worker process per story, at most `parallel` at a time
// ---------------------------------------------------------------------------------------------

export function plan(config, inputs, { base = config.baseRef, force = false } = {}) {
  const stories = orderStories(collectStories(inputs));
  const byKey = new Map(stories.map((s) => [s.key, s]));
  for (const s of stories) s.skip = s.implemented && !force ? 'already implemented (has "## Implementation Notes"; --force to redo)' : null;
  // Blockers already implemented are on the base branch, so only the ones built in this run count.
  const ancestors = new Map();
  for (const s of stories) {
    s.deps = s.deps.filter((k) => !byKey.get(k).skip);
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
    .map((s, i) => `${String(i + 1).padStart(2)}. ${s.key.padEnd(10)} ${s.skip ? `skip: ${s.skip}` : `${s.branch} <- ${s.base}${s.merge.length ? ` + ${s.merge.join(', ')}` : ''}`}${s.blockedBy.length ? `  (blocked by ${s.blockedBy.join(', ')})` : ''}`)
    .join('\n');
}

export async function runBatch(config, stories, { parallel = 1, pr = false, script }) {
  fs.mkdirSync(runsDir(config), { recursive: true });
  const outcome = new Map(stories.filter((s) => s.skip).map((s) => [s.key, { outcome: 'skipped', reason: s.skip }]));
  for (const s of stories) saveRun(config, s.key, s.skip ? { outcome: 'skipped', reason: s.skip, status: 'finished' } : { status: 'queued', outcome: null, reason: null, branch: s.branch, worktree: s.worktree, base: s.base });

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
  saveRun(config, story.key, { status: 'running', startedAt: nowIso(), log: path.relative(config.root, logPath) });
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
  // PIPELINE_HEADLESS: the board stage waits for the PR before moving the card to Pending Review.
  const env = { ...process.env, PIPELINE_ROOT: worktree, PIPELINE_BASE_REF: base, PIPELINE_HEADLESS: '1' };
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

async function waitForQe(config, key, timeoutSec, pollSec) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSec * 1000;
  for (;;) {
    const a = loadState(config, key).automation;
    if (QE_TERMINAL.has(a.status) && !a.requestedHash) return a;
    if (a.status === 'running' && a.pid && !isPidAlive(a.pid)) return { ...a, status: 'crashed' };
    if (a.status === 'idle' && Date.now() - startedAt > 30_000) return { ...a, status: 'not-started' };
    if (Date.now() > deadline) return { ...a, status: 'timed-out' };
    await sleep(pollSec * 1000);
  }
}

// Settings the environment overrides: PIPELINE_VERIFIER_CLI runs both verifiers on another CLI, and
// IMPLEMENT_ORCHESTRATE=0 falls back to one implementer agent per story.
export function applyEnv(config) {
  const s = config.implement;
  if (process.env.IMPLEMENT_ORCHESTRATE === '0') s.orchestrate = false;
  if (process.env.PIPELINE_VERIFIER_CLI) for (const r of ['verifier', 'uiVerifier']) s.roles[r] = { ...s.roles[r], cli: process.env.PIPELINE_VERIFIER_CLI };
  return config;
}

export async function implementStory(config, opts) {
  const holder = {};
  try {
    return await implementStoryInner(config, opts, holder);
  } finally {
    if (holder.ctx) await holder.ctx.deps.lsp.stopAll();
  }
}

const lastReviewFindings = (wt, key) => readJsonl(metricsFile(wt, 'arch-reviews.jsonl')).filter((r) => r.story === key).at(-1)?.findings ?? [];

async function implementStoryInner(config, opts, holder) {
  const { key, base, branch, worktree, pr } = opts;
  const settings = config.implement;
  const started = Date.now();
  const metrics = { implementerRuns: 0, reviewBlocks: 0, bugFixCycles: 0, promptVersion: null };
  let ctx = null;
  const extraMetrics = () =>
    ctx
      ? {
          mode: ctx.metrics.mode,
          decisionId: ctx.decisionId,
          subtasks: ctx.plan?.subtasks.length ?? 0,
          agentRuns: ctx.metrics.agentRuns,
          pairRounds: ctx.metrics.pairRounds,
          takeovers: ctx.metrics.takeovers,
          escalations: ctx.metrics.escalations,
          limitHit: ctx.metrics.limitHit,
          lspCalls: ctx.metrics.lspCalls,
          signatureChangesWithoutReferences: ctx.metrics.signatureChangesWithoutReferences,
        }
      : {};
  const finish = (outcome, reason = null, extra = {}) => ({ key, outcome, reason, branch, worktree, base, minutes: Math.round((Date.now() - started) / 600) / 100, ...metrics, ...extraMetrics(), ...extra });

  const prep = prepareWorktree(config, opts);
  if (prep.error) return finish('blocked', prep.error);
  const wt = applyEnv(prep.config);
  const start = pipeline(worktree, base, ['start', key]);
  if (start.status !== 0) return finish('error', `pipeline start failed: ${tail(start.stderr, 500)}`);

  const orchestrated = wt.implement.orchestrate !== false;
  const recordOutcome = (outcome, reason) => {
    const m = extraMetrics();
    appendJsonl(metricsFile(wt, 'implement-runs.jsonl'), [{ ts: nowIso(), story: key, outcome, implementer_runs: metrics.implementerRuns, review_blocks: metrics.reviewBlocks, bug_fix_cycles: metrics.bugFixCycles, minutes: Math.round((Date.now() - started) / 600) / 100, prompt_version: metrics.promptVersion, ...(ctx ? { mode: m.mode, decision_id: m.decisionId, subtasks: m.subtasks, agent_runs: m.agentRuns, pair_rounds: m.pairRounds, takeovers: m.takeovers, escalations: m.escalations, limit_hit: m.limitHit, lsp_calls: m.lspCalls, signature_changes_without_references: m.signatureChangesWithoutReferences } : {}) }]);
    if (ctx) appendJsonl(metricsFile(wt, OUTCOMES_FILE), [storyOutcomeRecord({ ts: nowIso(), key, decisionId: ctx.decisionId, mode: ctx.metrics.mode, outcome, reason, wallClockSec: Math.round((Date.now() - started) / 1000), agentRuns: ctx.metrics.agentRuns, reviewBlocks: metrics.reviewBlocks, bugFixCycles: metrics.bugFixCycles, limitHit: ctx.metrics.limitHit, branch, lspCalls: ctx.metrics.lspCalls, signatureChangesWithoutReferences: ctx.metrics.signatureChangesWithoutReferences })]);
  };
  const recordEscaped = (source, findings, files) => {
    if (!ctx?.plan) return;
    const recs = attributeEscaped({ ts: nowIso(), key, decisionId: ctx.decisionId, subtasks: ctx.plan.subtasks, source, findings, files });
    if (recs.length) appendJsonl(metricsFile(wt, OUTCOMES_FILE), recs);
  };
  // A story that stops before the review loop still records (and commits) its metrics.
  const stop = (outcome, reason, extra = {}) => {
    recordOutcome(outcome, reason);
    commitAll(worktree, `${key}: Record implement metrics`, [wt.metricsDir]);
    return { ...finish(outcome, reason, extra), finalSha: headSha(worktree) };
  };

  let feedback = null;
  let skipNextRun = false;
  let integration = null;
  if (orchestrated) {
    ctx = createContext({ config: wt, key, storyFile: prep.story, branch, worktree, base, onProgress: (patch) => saveRun(config, key, patch) });
    holder.ctx = ctx;
    await ctx.deps.lsp.start(worktree);
    const o = await orchestrate(ctx);
    if (!o.ok) return stop(o.outcome, o.reason, { findings: o.findings });
    // Self mode: the verifier already approved the orchestrator's own work, so the review comes next.
    skipNextRun = o.mode === 'self';
    if (o.mode === 'delegate') integration = integrationTask({ key, storyFile: prep.story, branch, worktree, base, plan: o.plan, notes: o.integrationNotes });
  }

  let qe = null;
  let fixingBugs = false;
  for (;;) {
    // Implementation and review loop: the review's stop hook blocks with findings until it approves.
    let approved = false;
    while (!approved) {
      if (skipNextRun) {
        skipNextRun = false;
      } else {
        if (metrics.implementerRuns >= settings.maxImplementerRuns) return ctx ? stop('unresolved', `still not approved after ${metrics.implementerRuns} implementer runs`) : finish('unresolved', `still not approved after ${metrics.implementerRuns} implementer runs`);
        let left = settings.implementerTimeoutSec;
        let release = null;
        if (ctx) {
          try {
            left = Math.min(left, checkBudget(ctx));
          } catch (error) {
            if (error instanceof LimitError) return stop(error.outcome, error.message);
            throw error;
          }
          release = await ctx.deps.acquire(`${key}:implementer`);
          ctx.metrics.agentRuns++;
          ctx.metrics.byRole.orchestrator = (ctx.metrics.byRole.orchestrator ?? 0) + 1;
        }
        metrics.implementerRuns++;
        const before = headSha(worktree);
        const task = integration ?? implementerTask({ key, storyFile: prep.story, branch, worktree, base, feedback });
        integration = null;
        const { cli, model } = agentSettings(wt, 'orchestrator');
        let res;
        try {
          res = runAgent(wt, { name: 'implementer', task, mode: 'implement', model, cli, noSubagents: Boolean(ctx), timeoutSec: left, usage: { stage: 'implement', story: key, round: metrics.implementerRuns } });
        } finally {
          release?.();
        }
        metrics.promptVersion = res.version;
        const reported = extractResult(res.output);
        commitAll(worktree, `${key}: Implementation`);
        if (fixingBugs) {
          recordEscaped('qe', (qe?.bugs ?? []).map((b) => (typeof b === 'string' ? { issue: b } : b)), filesChanged(worktree, before));
          fixingBugs = false;
        }
        if (reported?.status === 'blocked') return ctx ? stop('blocked', reported.reason ?? 'the implementer reported the story blocked') : finish('blocked', reported.reason ?? 'the implementer reported the story blocked');
        if (!res.ok && !reported) {
          feedback = `The previous run ${res.timedOut ? 'timed out' : `failed (exit ${res.status})`} before finishing. Continue the implementation.`;
          continue;
        }
        if (ctx) {
          // Language server errors in the story's changed files go straight back to the orchestrator.
          const diag = await ctx.deps.lsp.diagnostics(worktree, filesChanged(worktree, ctx.storyBaseSha));
          if (diag.errors.length) {
            feedback = `The language server reports errors in files this story changed. Fix them, then finish again:\n\n${formatDiagnostics({ ...diag, warnings: [] })}`;
            continue;
          }
        }
      }
      const done = pipeline(worktree, base, ['done', key]);
      if (/\(0 implementation file/.test(done.stdout)) return ctx ? stop('no-changes', 'no implementation files changed') : finish('no-changes', 'the implementer changed no implementation files');
      const stopHook = pipeline(worktree, base, ['hook', 'stop'], '{}');
      let output = null;
      try {
        output = stopHook.stdout.trim() ? JSON.parse(stopHook.stdout) : null;
      } catch {
        output = null;
      }
      if (output?.decision === 'block') {
        metrics.reviewBlocks++;
        feedback = output.reason;
        recordEscaped('arch-review', lastReviewFindings(wt, key).filter((f) => f.severity !== 'minor'), []);
        continue;
      }
      const review = loadState(wt, key).review;
      if (review.lastVerdict === 'ESCALATED') return ctx ? stop('review-escalated', review.lastReason ?? 'the review did not converge') : finish('review-escalated', review.lastReason ?? 'the review did not converge');
      if (review.lastVerdict !== 'APPROVED') return ctx ? stop('unresolved', output?.systemMessage ?? `review verdict ${review.lastVerdict ?? 'none'}`) : finish('unresolved', output?.systemMessage ?? `review verdict ${review.lastVerdict ?? 'none'}`);
      approved = true;
    }

    // QE writes and verifies the tests in the background; wait for its verdict.
    qe = await waitForQe(wt, key, settings.qeTimeoutSec, settings.qePollSec);
    if (qe.status !== 'product-bug') break;
    if (metrics.bugFixCycles >= settings.maxBugFixCycles) break;
    metrics.bugFixCycles++;
    fixingBugs = true;
    feedback = `The automated tests found implementation bugs. Fix the implementation (not the tests):\n${(qe.bugs ?? []).map((b) => `- ${typeof b === 'string' ? b : JSON.stringify(b)}`).join('\n')}`;
  }

  const outcome = qe.status === 'verified' ? 'done' : `qe-${qe.status}`;
  const qeReason = outcome === 'done' ? null : `QE ended ${qe.status}${qe.bugs?.length ? `: ${qe.bugs.length} bug(s)` : ''}`;
  const qeFindings = outcome === 'done' ? undefined : (qe.bugs ?? []).map((b) => (typeof b === 'string' ? b : b.title ?? b.issue ?? JSON.stringify(b)));
  const result = finish(outcome, qeReason, qeFindings?.length ? { findings: qeFindings } : {});
  recordOutcome(outcome, qeReason);
  commitAll(worktree, `${key}: Add verified test plan and automated tests`);
  result.finalSha = headSha(worktree);

  if (pr && outcome === 'done') {
    const push = git(worktree, ['push', '-u', 'origin', branch]);
    if (push.status !== 0) return { ...result, reason: `push failed: ${tail(push.stderr, 300)}` };
    const baseBranch = base.replace(/^origin\//, '');
    const title = `${key}: ${fs.readFileSync(prep.story, 'utf8').match(/^#\s+(.+)$/m)?.[1]?.replace(new RegExp(`^${key}[:\\s-]*`), '') ?? key}`;
    const orch = ctx ? `\n- Orchestration: ${ctx.metrics.mode}${ctx.plan?.mode === 'delegate' ? ` (${ctx.plan.subtasks.length} subtasks, ${ctx.metrics.pairRounds} pair rounds, ${ctx.metrics.takeovers} takeover(s))` : ''}, ${ctx.metrics.agentRuns} agent runs` : '';
    const body = `Implements ${path.relative(worktree, prep.story)} (generated by \`pipeline implement\`).\n\n- Architecture review: approved\n- Test plan and automated tests: verified\n- Implementer runs: ${metrics.implementerRuns}, review rounds blocked: ${metrics.reviewBlocks}, QE bug-fix cycles: ${metrics.bugFixCycles}${orch}`;
    const created = run('gh', ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', title, '--body', body], { cwd: worktree });
    const prUrl = created.status === 0 ? created.stdout.trim() : null;
    reportToBoard(worktree, key, prUrl);
    return { ...result, pr: prUrl, ...(created.status !== 0 ? { reason: `gh pr create failed: ${tail(created.stderr, 300)}` } : {}) };
  }
  if (outcome === 'done') reportToBoard(worktree, key, null);
  return result;
}

// Moves the story's card to Pending Review with its evidence. The board is informational, so a failure
// is logged and never changes the outcome.
function reportToBoard(worktree, key, prUrl) {
  if (!fs.existsSync(BOARD_CLI)) return;
  const env = { ...process.env, PIPELINE_ROOT: worktree };
  delete env.PIPELINE_CHILD;
  const r = run(process.execPath, [BOARD_CLI, 'review', key, ...(prUrl ? ['--pr', prUrl] : [])], { cwd: worktree, env });
  log(`${key}: board: ${(r.status === 0 ? r.stdout : r.stderr).trim().split('\n').at(-1) || `exit ${r.status}`}`);
}

export function formatSummary(results) {
  const rows = results.map((r) => `${r.key.padEnd(10)} ${String(r.outcome ?? '-').padEnd(18)} ${r.branch ?? ''}${r.pr ? `  ${r.pr}` : ''}${r.reason ? `\n${' '.repeat(11)}${r.reason}` : ''}`);
  return `${'Story'.padEnd(10)} ${'Outcome'.padEnd(18)} Branch\n${rows.join('\n')}`;
}
