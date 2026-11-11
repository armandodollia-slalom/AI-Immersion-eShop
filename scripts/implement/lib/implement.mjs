import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runAgent } from '../../pipeline/lib/agents.mjs';
import { INSTALL_ROOT, loadConfig } from '../../pipeline/lib/config.mjs';
import { formatBugs, normalizeBugs } from '../../pipeline/lib/decisions.mjs';
import { git, implChanges, revExists } from '../../pipeline/lib/git.mjs';
import { loadState, metricsFile } from '../../pipeline/lib/state.mjs';
import { prsDisabled, runTags } from '../../pipeline/lib/run-tags.mjs';
import { addUsage } from '../../pipeline/lib/usage.mjs';
import { activeStoryFile } from '../../pipeline/lib/stories.mjs';
import { ticketFile, writeTicket } from '../../board/lib/source.mjs';
import { metaFor } from '../../board/lib/ticket-format.mjs';
import { appendJsonl, extractResult, isProcessAlive, log, nowIso, readJson, readJsonl, run, sleep, tail, writeJson } from '../../pipeline/lib/util.mjs';
import { branchFor, collectStories, orderStories, worktreeFor } from './batch.mjs';
import { boardEvent } from './board-events.mjs';
import { OUTCOMES_FILE, attributeEscaped, storyOutcomeRecord } from './decisions.mjs';
import { commitAll, commitEnv, filesChanged, headSha, listSubtaskWorktrees, mustGit, removeWorktree } from './gitops.mjs';
import { formatDiagnostics, lspAdapter } from './lsp.mjs';
import { LimitError, agentSettings, checkBudget, createContext, orchestrate } from './orchestrate.mjs';
import { applyResources, resourcesFromEnv, waitForMemory } from './resources.mjs';
import { newFeedbackLog } from './feedback.mjs';
import { epicNoteBlock, integrationTask } from './tasks.mjs';

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
        // Back-pressure: a new story waits while free memory is below the reserve (auto sizing).
        running.set(s.key, waitForMemory(config, s.key).then(() => startWorker(config, s, { pr, script })).then((r) => [s, r]));
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

export function startWorker(config, story, { pr, script }) {
  const resultFile = path.join(runsDir(config), `${story.key}.result.json`);
  const logPath = path.join(config.root, config.stateDir, 'logs', `implement-${story.key}-${nowIso().replace(/[:.]/g, '-')}.log`);
  fs.rmSync(resultFile, { force: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const args = ['story', story.key, '--file', story.file, '--base', story.base, '--branch', story.branch, '--worktree', story.worktree, '--result', resultFile];
  if (story.merge?.length) args.push('--merge', story.merge.join(','));
  // Epic delivery: the story gets the epic design note, and the runner merges it into the epic branch
  // and moves its card after the worker ends.
  if (story.epicNote) args.push('--epic-note', story.epicNote);
  if (story.epicBranch) args.push('--epic-branch', story.epicBranch);
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
  // The ticket (story, metadata, its own mockups) goes into the worktree's ticket cache, so the review,
  // QE and PR check stages there read the same text. A resumed run keeps the worktree's copy (it may
  // carry the implementer's Implementation Notes).
  const wtConfig = loadConfig('implement', worktree);
  const target = ticketFile(wtConfig, key);
  if (!fs.existsSync(target)) {
    const meta = path.join(path.dirname(file), 'meta.json');
    if (path.basename(file) === 'story.md' && fs.existsSync(meta)) {
      fs.mkdirSync(path.dirname(path.dirname(target)), { recursive: true });
      fs.cpSync(path.dirname(file), path.dirname(target), { recursive: true });
    } else {
      const text = fs.readFileSync(file, 'utf8');
      const slug = path.basename(file, '.md');
      writeTicket(wtConfig, key, { content: text, meta: metaFor({ key, type: 'story', title: /^#\s+(.+)$/m.exec(text)?.[1] ?? key, slug, source: null }, text), origin: 'file' });
    }
  }
  // The epic's ticket (body and mockups) goes along when the run handed it over (`--epic`, or epic
  // delivery), so the story's mockups-from-the-epic are found in the worktree too.
  const parent = readJson(path.join(path.dirname(file), 'meta.json'), {})?.parent;
  const epicDir = parent ? path.join(path.dirname(path.dirname(file)), parent) : null;
  const handed = (process.env.PIPELINE_STORY_SOURCES ?? '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
  if (epicDir && fs.existsSync(epicDir) && handed.includes(path.resolve(epicDir))) {
    const dst = path.join(path.dirname(path.dirname(target)), parent);
    if (!fs.existsSync(dst)) fs.cpSync(epicDir, dst, { recursive: true });
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

function implementerTask({ key, storyFile, branch, worktree, base, feedback, epicNote = null }) {
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
    'AGENT_RESULT: {"status": "done" | "blocked" | "partial", "reason": "<one sentence>", "disputes": [{"finding": "<finding id>", "kind": "nit" | "out-of-scope", "reason": "<the acceptance criterion, owns or mockup that shows why>"}], "followUps": [{"title": "<real problem outside this ticket>", "reason": "<why it matters>"}]}',
  ];
  if (epicNote) lines.push('', epicNoteBlock(epicNote));
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

// Settings the environment overrides: PIPELINE_VERIFIER_CLI runs both verifiers on another CLI, and
// IMPLEMENT_ORCHESTRATE=0 falls back to one implementer agent per story.
export function applyEnv(config) {
  const s = config.implement;
  if (process.env.IMPLEMENT_ORCHESTRATE === '0') s.orchestrate = false;
  // Experiments give every arm its own branch names (scripts/pipeline/lib/experiment.mjs).
  if (process.env.IMPLEMENT_BRANCH_PREFIX) s.branchPrefix = process.env.IMPLEMENT_BRANCH_PREFIX;
  s.epic = { ...(s.epic ?? {}) };
  if (process.env.IMPLEMENT_EPIC_BRANCH_PREFIX) s.epic.branchPrefix = process.env.IMPLEMENT_EPIC_BRANCH_PREFIX;
  if (process.env.IMPLEMENT_BUGFIX_BRANCH_PREFIX) s.epic.bugfixPrefix = process.env.IMPLEMENT_BUGFIX_BRANCH_PREFIX;
  if (process.env.IMPLEMENT_WORKTREE_DIR) s.worktreeDir = process.env.IMPLEMENT_WORKTREE_DIR;
  applyResources(config);
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

// The token usage and cost columns of a run record, from a summary (see summarizeUsage in usage.mjs).
export const usageFields = (u) => ({ tokens: u?.tokens?.total ?? null, cost_usd: u?.costUsd ?? null, premium_requests: u?.premiumRequests ?? null, unpriced_runs: u?.unpriced ?? null });

// Leftovers of an interrupted orchestrated run: its subtask worktrees and branches (with their language
// servers). Stack slot leases need nothing: a lease whose owner died is stale and reclaimed.
export async function cleanupSubtasks(config, key) {
  const lsp = lspAdapter(config);
  for (const w of listSubtaskWorktrees(config.root, config.implement.branchPrefix, key)) {
    await lsp.stop(w.path).catch(() => {});
    removeWorktree(config.root, w.path, w.branch);
    log(`${key}: removed ${w.branch} left by the interrupted run`);
  }
}

const lastReviewFindings = (wt, key) => readJsonl(metricsFile(wt, 'arch-reviews.jsonl')).filter((r) => r.story === key).at(-1)?.findings ?? [];

async function implementStoryInner(config, opts, holder) {
  const { key, base, branch, worktree, pr } = opts;
  const settings = config.implement;
  const started = Date.now();
  const metrics = { implementerRuns: 0, reviewBlocks: 0, bugFixCycles: 0, promptVersion: null };
  let ctx = null;
  // Usage of the implementer runs this function starts itself (the orchestrator's integration and fix
  // runs); the planner, pairs and verifiers add up in ctx.metrics.usage.
  let storyUsage = null;
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
  // Disputes and follow-ups the implementer raised against review findings and QE bugs (lib/feedback.mjs);
  // the pairs' own follow-ups are in ctx.metrics.followUps.
  const feedbackLog = newFeedbackLog();
  const allFollowUps = () => [...(ctx?.metrics.followUps ?? []), ...feedbackLog.followUps];
  const finish = (outcome, reason = null, extra = {}) => ({ key, outcome, reason, branch, worktree, base, minutes: Math.round((Date.now() - started) / 600) / 100, ...metrics, ...extraMetrics(), ...usageFields(addUsage(ctx?.metrics.usage ?? null, storyUsage)), followUps: allFollowUps(), disputes: feedbackLog.counts(), ...extra });

  const prep = prepareWorktree(config, opts);
  if (prep.error) return finish('blocked', prep.error);
  // Epic delivery: the epic design note (written by the epic plan) goes to the orchestrator's plan.
  const epicNote = opts.epicNote && fs.existsSync(opts.epicNote) ? fs.readFileSync(opts.epicNote, 'utf8') : null;
  const wt = applyEnv(prep.config);
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
    const active = activeStoryFile(wt);
    const alreadyStarted = Boolean(prior) && Boolean(active) && path.basename(path.dirname(active)) === key;
    if (!alreadyStarted) {
      const start = pipeline(worktree, base, ['start', key]);
      if (start.status !== 0) return finish('error', `pipeline start failed: ${tail(start.stderr, 500)}`);
    }
    if (opts.resume) feedback = 'A previous run of this story was interrupted. Its work so far is on this branch (committed, or still uncommitted in the worktree). Review it and continue the implementation rather than starting over.';
  }

  // A resumed story does not plan again: subtask worktrees, stack slots and language servers of the
  // interrupted run are cleaned up (approved subtasks were already merged into the story branch), and
  // the orchestrator continues the story itself from what is on the branch, like a single implementer.
  const orchestrated = wt.implement.orchestrate !== false && !opts.resume;
  if (opts.resume && wt.implement.orchestrate !== false) await cleanupSubtasks(wt, key);
  const recordOutcome = (outcome, reason) => {
    const m = extraMetrics();
    appendJsonl(metricsFile(wt, 'implement-runs.jsonl'), [{ ts: nowIso(), story: key, outcome, implementer_runs: metrics.implementerRuns, review_blocks: metrics.reviewBlocks, bug_fix_cycles: metrics.bugFixCycles, minutes: Math.round((Date.now() - started) / 600) / 100, prompt_version: metrics.promptVersion, ...(ctx ? { mode: m.mode, decision_id: m.decisionId, subtasks: m.subtasks, agent_runs: m.agentRuns, pair_rounds: m.pairRounds, takeovers: m.takeovers, escalations: m.escalations, limit_hit: m.limitHit, lsp_calls: m.lspCalls, signature_changes_without_references: m.signatureChangesWithoutReferences } : {}), ...usageFields(addUsage(ctx?.metrics.usage ?? null, storyUsage)), ...(resourcesFromEnv() ? { resources: resourcesFromEnv() } : {}), disputes: feedbackLog.counts(), follow_ups: allFollowUps(), ...runTags() }]);
    if (ctx) appendJsonl(metricsFile(wt, OUTCOMES_FILE), [{ ...storyOutcomeRecord({ ts: nowIso(), key, decisionId: ctx.decisionId, mode: ctx.metrics.mode, outcome, reason, wallClockSec: Math.round((Date.now() - started) / 1000), agentRuns: ctx.metrics.agentRuns, reviewBlocks: metrics.reviewBlocks, bugFixCycles: metrics.bugFixCycles, limitHit: ctx.metrics.limitHit, branch, lspCalls: ctx.metrics.lspCalls, signatureChangesWithoutReferences: ctx.metrics.signatureChangesWithoutReferences, usage: addUsage(ctx.metrics.usage, storyUsage), followUps: ctx.metrics.followUps }), ...runTags() }]);
  };
  const recordEscaped = (source, findings, files) => {
    if (!ctx?.plan) return;
    const recs = attributeEscaped({ ts: nowIso(), key, decisionId: ctx.decisionId, subtasks: ctx.plan.subtasks, source, findings, files });
    if (recs.length) appendJsonl(metricsFile(wt, OUTCOMES_FILE), recs.map((r) => ({ ...r, ...runTags() })));
  };
  // A story that stops before the review loop still records (and commits) its metrics.
  const stop = (outcome, reason, extra = {}) => {
    recordOutcome(outcome, reason);
    commitAll(worktree, `${key}: Record implement metrics`, [wt.metricsDir]);
    return { ...finish(outcome, reason, extra), finalSha: headSha(worktree) };
  };

  let skipNextRun = false;
  let integration = null;
  if (orchestrated && !skipImplementer) {
    ctx = createContext({ config: wt, key, storyFile: prep.story, branch, worktree, base, epicNote, onProgress: (patch) => saveRun(config, key, patch) });
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
    let approved = skipImplementer;
    skipImplementer = false;
    while (!approved) {
      let reported = null;
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
        const task = integration ?? implementerTask({ key, storyFile: prep.story, branch, worktree, base, feedback, epicNote: ctx ? null : epicNote });
        integration = null;
        const { cli, model } = agentSettings(wt, 'orchestrator');
        let res;
        try {
          res = runAgent(wt, { name: 'implementer', task, mode: 'implement', model, cli, noSubagents: Boolean(ctx), timeoutSec: left, usage: { stage: 'implement', story: key, round: metrics.implementerRuns } });
        } finally {
          release?.();
        }
        storyUsage = addUsage(storyUsage, res.usage);
        metrics.promptVersion = res.version;
        reported = extractResult(res.output);
        commitAll(worktree, `${key}: Implementation`);
        // Disputes of the findings it was given go to the next review round (or are recorded, for QE
        // bugs); follow-ups are collected for the run record.
        feedbackLog.afterRun(wt, key, reported, { round: metrics.implementerRuns });
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
      if (/\(0 implementation file/.test(done.stdout)) return ctx ? stop('no-changes', reported?.reason ?? 'no implementation files changed') : finish('no-changes', reported?.reason ?? 'the implementer changed no implementation files');
      const stopHook = pipeline(worktree, base, ['hook', 'stop'], '{}');
      let output;
      try {
        output = stopHook.stdout.trim() ? JSON.parse(stopHook.stdout) : null;
      } catch {
        output = null;
      }
      if (output?.decision === 'block') {
        metrics.reviewBlocks++;
        feedback = `${output.reason}${feedbackLog.given('architecture-reviewer', lastReviewFindings(wt, key).filter((f) => f.severity !== 'minor'), { round: metrics.reviewBlocks, config: wt, key })}`;
        recordEscaped('arch-review', lastReviewFindings(wt, key).filter((f) => f.severity !== 'minor'), []);
        continue;
      }
      const review = loadState(wt, key).review;
      if (review.lastVerdict === 'ESCALATED') return ctx ? stop('review-escalated', review.lastReason ?? 'the review did not converge') : finish('review-escalated', review.lastReason ?? 'the review did not converge');
      if (review.lastVerdict !== 'APPROVED') return ctx ? stop('unresolved', output?.systemMessage ?? `review verdict ${review.lastVerdict ?? 'none'}`) : finish('unresolved', output?.systemMessage ?? `review verdict ${review.lastVerdict ?? 'none'}`);
      approved = true;
    }

    // The review approved this code and QE is testing it: the card moves to Testing.
    const approvedHash = loadState(wt, key).review.approvedHash;
    boardEvent(worktree, key, ['event', key, 'testing', ...(approvedHash ? ['--id', `testing:${approvedHash}`] : [])]);
    // QE writes and verifies the tests in the background; wait for its verdict.
    qe = await waitForQe(wt, key, { timeoutSec: settings.qeTimeoutSec, pollSec: settings.qePollSec, recover: () => pipeline(worktree, base, ['resume', key]) });
    if (qe.status !== 'product-bug') break;
    if (metrics.bugFixCycles >= settings.maxBugFixCycles) break;
    metrics.bugFixCycles++;
    // Back to the implementer: the card returns to In Progress with the bugs.
    boardEvent(worktree, key, ['event', key, 'product-bug', ...(qe.finishedAt ? ['--id', `bug:${qe.finishedAt}`] : [])], { input: JSON.stringify({ bugs: qe.bugs ?? [], cycle: metrics.bugFixCycles }) });
    fixingBugs = true;
    feedback = `The automated tests found implementation bugs. Fix the implementation (not the tests):\n${formatBugs(qe.bugs)}${feedbackLog.given('qe-automation', normalizeBugs(qe.bugs).map((b) => ({ issue: [b.case, b.reason].filter(Boolean).join(': '), severity: 'blocking' })), { round: metrics.bugFixCycles })}`;
  }

  const outcome = qe.status === 'verified' ? 'done' : `qe-${qe.status}`;
  const qeReason = outcome === 'done' ? null : `QE ended ${qe.status}${qe.bugs?.length ? `: ${qe.bugs.length} bug(s)` : ''}`;
  const qeFindings = outcome === 'done' ? undefined : (qe.bugs ?? []).map((b) => (typeof b === 'string' ? b : b.title ?? b.issue ?? JSON.stringify(b)));
  const result = finish(outcome, qeReason, qeFindings?.length ? { findings: qeFindings } : {});
  recordOutcome(outcome, qeReason);
  commitAll(worktree, `${key}: Add verified test plan and automated tests`);
  result.finalSha = headSha(worktree);

  // Epic delivery: no PR per story. The epic runner merges the story into the epic branch, publishes
  // the ticket and moves the card to Pending Review (board review --epic-branch) once it has merged.
  if (opts.epicBranch) return result;
  if (pr && outcome === 'done' && !prsDisabled()) {
    const push = git(worktree, ['push', '-u', 'origin', branch]);
    if (push.status !== 0) return { ...result, reason: `push failed: ${tail(push.stderr, 300)}` };
    const baseBranch = base.replace(/^origin\//, '');
    const title = `${key}: ${fs.readFileSync(prep.story, 'utf8').match(/^#\s+(.+)$/m)?.[1]?.replace(new RegExp(`^${key}[:\\s-]*`), '') ?? key}`;
    const orch = ctx ? `\n- Orchestration: ${ctx.metrics.mode}${ctx.plan?.mode === 'delegate' ? ` (${ctx.plan.subtasks.length} subtasks, ${ctx.metrics.pairRounds} pair rounds, ${ctx.metrics.takeovers} takeover(s))` : ''}, ${ctx.metrics.agentRuns} agent runs` : '';
    const issueUrl = readJson(path.join(path.dirname(prep.story), 'meta.json'), {})?.issue?.url;
    const body = `Implements ${key}${issueUrl ? ` (${issueUrl})` : ''} (generated by \`pipeline implement\`).\n\n- Architecture review: approved\n- Test plan and automated tests: verified\n- Implementer runs: ${metrics.implementerRuns}, review rounds blocked: ${metrics.reviewBlocks}, QE bug-fix cycles: ${metrics.bugFixCycles}${orch}\n\nThe demo video of the changed e2e specs (and, for backend changes, an API summary of the endpoints) is added below by the PR demo video workflow once it has recorded them.`;
    const created = run('gh', ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', title, '--body', body], { cwd: worktree });
    const prUrl = created.status === 0 ? created.stdout.trim() : null;
    publishTicket(worktree, key);
    reportToBoard(worktree, key, prUrl);
    return { ...result, pr: prUrl, ...(created.status !== 0 ? { reason: `gh pr create failed: ${tail(created.stderr, 300)}` } : {}) };
  }
  if (outcome === 'done') {
    publishTicket(worktree, key);
    reportToBoard(worktree, key, null);
  }
  return result;
}

// The implementer appends its Implementation Notes to the ticket's cached story; the issue is the source
// of truth, so the finished story's text goes back to it (no-op when unchanged or the board is off).
export function publishTicket(worktree, key) {
  boardEvent(worktree, key, ['publish', key]);
}

// Moves the story's card to Pending Review with its evidence. The board is informational, so a failure
// is logged and never changes the outcome.
function reportToBoard(worktree, key, prUrl) {
  const verifiedHash = loadState(loadConfig('implement', worktree), key).automation.verifiedHash;
  boardEvent(worktree, key, ['review', key, ...(prUrl ? ['--pr', prUrl] : []), ...(verifiedHash ? ['--id', `verified:${verifiedHash}`] : [])]);
}

export function formatSummary(results) {
  const rows = results.map((r) => `${r.key.padEnd(10)} ${String(r.outcome ?? '-').padEnd(18)} ${r.branch ?? ''}${r.pr ? `  ${r.pr}` : ''}${r.reason ? `\n${' '.repeat(11)}${r.reason}` : ''}`);
  return `${'Story'.padEnd(10)} ${'Outcome'.padEnd(18)} Branch\n${rows.join('\n')}`;
}
