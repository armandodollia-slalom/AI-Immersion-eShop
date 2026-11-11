// The orchestrated implement flow for one story, run by the harness (not by an LLM managing loops):
//   plan (orchestrator, read mode) -> validate -> verifier pairs per subtask, in their own worktrees, at
//   most `maxConcurrentPairs` at once -> escalation to the orchestrator -> serial merges into the story
//   branch -> (implement.mjs) integration pass, review loop, QE, PR.
// Every agent is a separate headless CLI process (claude, copilot, codex or PIPELINE_AGENT_CMD), so the
// flow does not depend on any one CLI's subagent features. See docs/ai-pipeline/implement.md.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runAgentAsync } from '../../pipeline/lib/agents.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { readDecisions } from '../../pipeline/lib/human-decisions.mjs';
import { metricsFile } from '../../pipeline/lib/state.mjs';
import { appendJsonl, extractResult, log as defaultLog, nowIso, runAsync, tail, writeJson } from '../../pipeline/lib/util.mjs';
import { logDecision } from '../../pipeline/lib/decisions.mjs';
import { runTags } from '../../pipeline/lib/run-tags.mjs';
import { addUsage } from '../../pipeline/lib/usage.mjs';
import { SUBTASK_RUNS_FILE, crossFindings, decisionRecord, planDecisionLog, roundRecord, subtaskRunRecord, verdictDecisionLog } from './decisions.mjs';
import { commitAll, commitEnv, createSubtaskWorktree, diffSince, discardChanges, filesChanged, headSha, mergeInProgress, removeWorktree, unmergedFiles } from './gitops.mjs';
import { disputeCounts, formatDisputes, openDisputes, parseImplementerReport, ruleDisputes, withIds } from './disputes.mjs';
import { diagnosticFindings, formatDiagnostics, lspAdapter, signatureChanges } from './lsp.mjs';
import { isUiStory, parsePlanOutput, parseVerdict, resolveModelForRole, roleCli, scopeViolations, topoOrder, validatePlan, validateRewrite } from './plan.mjs';
import { waitForMemory } from './resources.mjs';
import { formatMockups, formatRenders, hasMockups, mockupFilesOf, renderMockups, storyMockups } from './mockups.mjs';
import { acquire, semaphoreDir } from './semaphore.mjs';
import { stackAdapter } from './stack.mjs';
import { codeVerifierTask, conflictTask, escalationTask, pairImplementerTask, planTask, uiVerifierTask } from './tasks.mjs';

// A hard stop (agent runs, wall clock): the story ends with `outcome`.
export class LimitError extends Error {
  constructor(outcome, message) {
    super(message);
    this.outcome = outcome;
  }
}
class AbortedError extends Error {}

export function createContext({ config, key, storyFile, branch, worktree, base, epicNote = null, deps = {}, onProgress = () => {}, log = defaultLog }) {
  const s = config.implement;
  const started = Date.now();
  const ctx = {
    config,
    s,
    key,
    storyFile,
    storyText: fs.readFileSync(storyFile, 'utf8'),
    // A human's answers to an earlier run's escalation questions (decisions.md next to the story).
    decisions: readDecisions(storyFile),
    // Epic delivery: the epic design note, handed to the planner.
    epicNote,
    branch,
    worktree,
    base,
    started,
    deadline: started + s.storyWallClockSec * 1000,
    abort: new AbortController(),
    log: (m) => log(`${key}: ${m}`),
    storyBaseSha: headSha(worktree),
    decisionId: null,
    plan: null,
    subtasks: new Map(), // id -> { status, branch, worktree, rounds }
    integrationNotes: [],
    metrics: { agentRuns: 0, byRole: {}, pairRounds: 0, takeovers: 0, escalations: 0, limitHit: null, mode: null, lspCalls: 0, signatureChangesWithoutReferences: false, leaseWaitSec: 0, usage: null, followUps: [] },
  };
  ctx.deps = {
    runAgent: deps.runAgent ?? runAgentAsync,
    stack: deps.stack ?? stackAdapter(config),
    lsp: deps.lsp ?? lspAdapter(config, { log: ctx.log }),
    acquire: deps.acquire ?? ((label) => acquire(semaphoreDir(config.root), s.maxConcurrentAgents, { deadline: ctx.deadline, label })),
    memoryGate: deps.memoryGate ?? ((label) => waitForMemory(config, label)),
    renderMockups: deps.renderMockups ?? renderMockups,
  };
  ctx.progress = () =>
    onProgress({
      orchestration: {
        mode: ctx.metrics.mode,
        decisionId: ctx.decisionId,
        agentRuns: ctx.metrics.agentRuns,
        lspCalls: ctx.metrics.lspCalls,
        signatureChangesWithoutReferences: ctx.metrics.signatureChangesWithoutReferences,
        followUps: ctx.metrics.followUps,
        subtasks: [...ctx.subtasks.entries()].map(([id, st]) => ({ id, ...st })),
      },
    });
  return ctx;
}

const record = (ctx, file, rec) => appendJsonl(metricsFile(ctx.config, file), { ...rec, ...runTags() });

// The story's mockups (its own, and the epic's when the epic was handed to the run), found once.
const mockupsOf = (ctx) => (ctx.mockups ??= storyMockups(ctx.config, ctx.storyFile));
const mockupText = (ctx) => (hasMockups(mockupsOf(ctx)) ? formatMockups(mockupsOf(ctx)) : null);

// Wall clock and agent-run budget for a story; throws LimitError when either is spent.
export function checkBudget(ctx) {
  if (ctx.abort.signal.aborted) throw new AbortedError('aborted');
  if (ctx.metrics.agentRuns >= ctx.s.maxAgentRunsPerStory) throw limit(ctx, 'limit-agent-runs', `the story used all ${ctx.s.maxAgentRunsPerStory} agent runs (maxAgentRunsPerStory)`);
  const left = ctx.deadline - Date.now();
  if (left <= 0) throw limit(ctx, 'limit-wall-clock', `the story ran past its ${ctx.s.storyWallClockSec}s wall clock (storyWallClockSec)`);
  return Math.floor(left / 1000);
}

function limit(ctx, outcome, message) {
  ctx.metrics.limitHit ??= outcome;
  return new LimitError(outcome, message);
}

// The model and CLI a role runs with.
export function agentSettings(config, role, modelClass, explicitModel = null) {
  const s = config.implement;
  const cli = s.roles?.[role]?.cli || null;
  const model = resolveModelForRole(config, role, modelClass, explicitModel);
  return { cli, model, cliName: config.agent.cmd ? 'custom' : roleCli(config, role) };
}

// Token usage is attributed to a stage per role; `step` is the plan, the merge or the subtask id.
const USAGE_STAGE = { orchestrator: 'implement', pairImplementer: 'implement-pair', verifier: 'implement-verify', uiVerifier: 'implement-ui-verify' };

// Runs one agent under the story's budget and the machine-wide agent semaphore.
export async function callAgent(ctx, { role, name, task, mode, modelClass = 'medium', model: explicitModel = null, cwd, timeoutSec, step = null, round = null }) {
  checkBudget(ctx);
  const release = await ctx.deps.acquire(`${ctx.key}:${name}`);
  if (!release) throw limit(ctx, 'limit-wall-clock', 'no agent slot (maxConcurrentAgents) before the story deadline');
  try {
    const left = checkBudget(ctx);
    ctx.metrics.agentRuns++;
    ctx.metrics.byRole[role] = (ctx.metrics.byRole[role] ?? 0) + 1;
    const { cli, model, cliName } = agentSettings(ctx.config, role, modelClass, explicitModel);
    const t0 = Date.now();
    // The story's own ticket (story and mockups) is open to every agent of its run, in whichever worktree
    // it works (the story guard matches the key in any checkout's ticket cache); nothing else is added.
    const extraEnv = { PIPELINE_STORY_SOURCES: [process.env.PIPELINE_STORY_SOURCES, ctx.key].filter(Boolean).join(path.delimiter) };
    const res = await ctx.deps.runAgent(ctx.config, { name, task, mode, model, cli, noSubagents: true, cwd, timeoutSec: Math.max(1, Math.min(timeoutSec, left)), signal: ctx.abort.signal, extraEnv, usage: { stage: USAGE_STAGE[role] ?? 'implement', story: ctx.key, step, round } });
    if (ctx.abort.signal.aborted) throw new AbortedError('aborted');
    if (res.timedOut && Date.now() >= ctx.deadline) throw limit(ctx, 'limit-wall-clock', `the story ran past its ${ctx.s.storyWallClockSec}s wall clock while ${name} was running`);
    ctx.metrics.usage = addUsage(ctx.metrics.usage, res.usage ?? null);
    const calls = ctx.deps.lsp.calls(cwd, name, t0, Date.now());
    ctx.metrics.lspCalls += calls.length;
    ctx.progress();
    return { ...res, cli: cliName, model, lspCalls: calls.length, referencesCalls: calls.filter((c) => ctx.deps.lsp.isReferences(c.tool)).length };
  } finally {
    release();
  }
}

// Build and unit tests, as the harness runs them for verifiers: `checks` always, plus the unit test
// project of every service with changed files.
export async function runChecks(ctx, cwd, files) {
  const parts = [];
  let ok = true;
  const exec = async (name, cmd) => {
    const r = await runAsync('sh', ['-c', cmd], { cwd, timeoutSec: ctx.s.timeouts.checkSec, signal: ctx.abort.signal });
    ok &&= r.status === 0;
    parts.push(`$ ${name}: ${r.status === 0 ? 'passed' : `FAILED (exit ${r.status}${r.timedOut ? ', timed out' : ''})`}\n${tail(`${r.stdout}\n${r.stderr}`.trim(), r.status === 0 ? 400 : 4000)}`);
  };
  for (const c of ctx.s.checks ?? []) await exec(c.name, c.cmd);
  const ut = ctx.s.unitTests;
  if (ut?.cmd) {
    const services = [...new Set(files.map((f) => /^src\/([^/]+)\//.exec(f)?.[1]).filter(Boolean))];
    for (const svc of services) {
      const project = ut.project.replace('{service}', svc);
      if (fs.existsSync(path.join(cwd, project))) await exec(`unit tests ${project}`, ut.cmd.replace('{project}', project));
    }
  }
  return { ok, output: parts.join('\n\n') || '(no checks configured)' };
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

const limitsOf = (s, config = null) => ({ maxSubtasks: s.maxSubtasks, maxLargeSubtasks: s.maxLargeSubtasks, selfModeMaxFiles: s.selfModeMaxFiles, ...(config ? { allowedModels: modelsFor(config) } : {}) });

// The model aliases a pair implementer may run on this run's CLI (allowed and with an id for it).
export const modelsFor = (config) => (config.agent.allowedModels ?? []).filter((a) => config.agent.cmd || config.agent.modelIds?.[roleCli(config, 'pairImplementer')]?.[a]);

export async function planStory(ctx) {
  // A ticket with mockups is a UI story even without an [FE] title.
  const uiStory = isUiStory(ctx.storyText) || hasMockups(mockupsOf(ctx));
  const limits = { ...limitsOf(ctx.s, ctx.config), hasMockups: hasMockups(mockupsOf(ctx)) };
  let errors = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await callAgent(ctx, {
      role: 'orchestrator',
      name: 'implementer',
      mode: 'read',
      step: 'plan',
      round: attempt,
      cwd: ctx.worktree,
      timeoutSec: ctx.s.timeouts.plannerSec,
      task: planTask({ key: ctx.key, storyFile: ctx.storyFile, worktree: ctx.worktree, uiStory, limits, errors, epicNote: ctx.epicNote, mockups: uiStory ? mockupText(ctx) : null, decisions: ctx.decisions }),
    });
    const raw = parsePlanOutput(res.output);
    const agent = { cli: res.cli, model: res.model, version: res.version };
    if (raw?.status === 'blocked') {
      logDecision(ctx.config, planDecisionLog(decisionRecord({ ts: nowIso(), key: ctx.key, attempt, accepted: false, errors: [`blocked: ${raw.reason ?? ''}`], agent, raw, storyText: ctx.storyText, uiStory }), { blocked: true }));
      return { fail: 'blocked', reason: raw.reason ?? 'the orchestrator reported the story blocked' };
    }
    const v = raw ? validatePlan(raw, { storyText: ctx.storyText, limits }) : { ok: false, errors: ['no plan found: end your reply with `AGENT_RESULT: <plan JSON on one line>`'], fatal: [] };
    const decisionId = v.ok ? randomUUID() : null;
    logDecision(ctx.config, planDecisionLog(decisionRecord({ ts: nowIso(), key: ctx.key, decisionId, attempt, accepted: v.ok, errors: v.errors, agent, raw, plan: v.plan, storyText: ctx.storyText, uiStory })));
    if (v.ok) {
      // Every model the plan needs must pass the model policy before any pair starts.
      try {
        for (const st of v.plan.subtasks) resolveModelForRole(ctx.config, st.self ? 'orchestrator' : 'pairImplementer', st.modelClass, st.model ?? null);
        for (const role of ['verifier', ...(v.plan.subtasks.some((st) => st.verify === 'ui') ? ['uiVerifier'] : [])]) resolveModelForRole(ctx.config, role);
      } catch (error) {
        return { fail: 'model-policy', reason: error.message };
      }
      ctx.decisionId = decisionId;
      ctx.plan = v.plan;
      writeJson(path.join(ctx.worktree, ctx.config.stateDir, 'implement', `${ctx.key}.plan.json`), { decisionId, ...v.plan });
      return { plan: v.plan };
    }
    if (v.fatal?.length) return { fail: 'plan-rejected', reason: v.fatal[0], findings: v.errors };
    errors = v.errors;
    ctx.log(`plan rejected (${errors.length} problem(s)); asking the orchestrator again`);
  }
  return { fail: 'plan-rejected', reason: `the plan was rejected twice: ${errors[0]}`, findings: errors };
}

// ---------------------------------------------------------------------------------------------
// Verifier pairs
// ---------------------------------------------------------------------------------------------

const newRec = (st) => ({ st, rounds: [], followUps: [], implementer: null, verifier: null, agentRuns: 0, leaseWaitSec: 0, lspCalls: 0, sigNoRefs: false, outOfOwns: new Set(), neededOutside: [], escalation: 'none', mergeConflictFiles: [], usage: null, started: Date.now() });

async function agentFor(ctx, rec, slot, opts) {
  const res = await callAgent(ctx, { step: rec.st.id, round: rec.rounds.length + 1, ...opts });
  rec.agentRuns++;
  rec.lspCalls += res.lspCalls;
  rec.usage = addUsage(rec.usage, res.usage ?? null);
  rec[slot] = { cli: res.cli, model: res.model, version: res.version };
  return res;
}

const PATHLIKE = /(?:^|[\s`'"(])((?:src|tests|testing|deploy|scripts|docs)\/[\w./-]+|[\w-]+\.(?:props|targets|json|slnx?|slnf))/g;

async function verifyCode(ctx, st, { worktree, base, round, checks, diagText, rec, disputes }) {
  const task = codeVerifierTask({ key: ctx.key, st, round, maxRounds: ctx.s.maxPairRounds, diff: diffSince(worktree, base), checks: checks.output, diagnostics: diagText, disputes, decisions: ctx.decisions });
  for (let attempt = 0; attempt <= ctx.config.agent.resultParseRetries; attempt++) {
    const res = await agentFor(ctx, rec, 'verifier', { role: 'verifier', name: 'pair-verifier', mode: 'read', modelClass: ctx.s.roles.verifier.modelClass, cwd: worktree, timeoutSec: ctx.s.timeouts.codeVerifierSec, task });
    discardChanges(worktree);
    const v = parseVerdict(res.output);
    if (v) return v;
  }
  return null;
}

// The stack slot is leased on the first UI round and kept for the rest of the pair (released by
// releaseUi when runPair ends), so later rounds only rebuild and recreate the services their diff
// touched instead of paying for a down/up and a full image build every round.
async function leaseUi(ctx, st, rec) {
  if (rec.ui) return rec.ui;
  const t0 = Date.now();
  const lease = await ctx.deps.stack.leaseUntil(`${ctx.key}--${st.id}`, { deadline: ctx.deadline, log: ctx.log });
  rec.leaseWaitSec += Math.round((Date.now() - t0) / 1000);
  ctx.metrics.leaseWaitSec += Math.round((Date.now() - t0) / 1000);
  if (!lease) throw limit(ctx, 'limit-wall-clock', `no app stack slot for subtask ${st.id} before the story deadline`);
  // Keep the lease alive through long builds and verifier runs.
  const renew = setInterval(() => ctx.deps.stack.renew?.(lease.slot).catch(() => {}), (ctx.s.ui.renewEverySec ?? 1800) * 1000);
  renew.unref?.();
  rec.ui = { lease, renew, up: false };
  return rec.ui;
}

async function releaseUi(ctx, rec, worktree) {
  if (!rec.ui) return;
  const { lease, renew } = rec.ui;
  rec.ui = null;
  clearInterval(renew);
  // Release does not stop the stack: bring it down first so the slot frees its memory.
  await ctx.deps.stack.teststack(worktree, lease.slot, ['down']).catch(() => {});
  await ctx.deps.stack.release(lease.slot);
}

async function verifyUi(ctx, st, { worktree, base, round, checks, diagText, rec, disputes }) {
  const shots = path.join(ctx.worktree, ctx.s.ui.screenshotsDir, ctx.key, st.id, `round-${round}`);
  fs.mkdirSync(shots, { recursive: true });
  const ui = await leaseUi(ctx, st, rec);
  const { lease } = ui;
  {
    // rebuild-changed first: it builds only the affected images (or everything when the slot's images
    // came from another worktree) and stamps them, so the following `up` starts without rebuilding.
    // `up` hashes all of src/ and would otherwise do a full build every round. Once the stack is up,
    // rebuild-changed recreates just the changed containers.
    const steps = [['rebuild-changed', '--base', base], ...(ui.up ? [] : [['up']]), ...(st.scenario ? [['load', st.scenario]] : [])];
    for (const step of steps) {
      const s0 = Date.now();
      const r = await ctx.deps.stack.teststack(worktree, lease.slot, step);
      // Builds wait on a machine-wide build lock; that time counts as stack wait.
      if (step[0] !== 'load') {
        rec.leaseWaitSec += Math.round((Date.now() - s0) / 1000);
        ctx.metrics.leaseWaitSec += Math.round((Date.now() - s0) / 1000);
      }
      if (r.status !== 0) {
        return { verdict: 'CHANGES_REQUESTED', summary: 'the app stack did not come up', screenshots: [], findings: [{ severity: 'blocking', category: 'stack', file: null, issue: `testing/teststack --slot ${lease.slot} ${step.join(' ')} failed (exit ${r.status})`, detail: tail(`${r.stdout}\n${r.stderr}`.trim(), 3000) }] };
      }
      if (step[0] === 'up') ui.up = true;
    }
    // The mockups, rendered to PNGs once per set of mockup files (cached by their sha) and copied into
    // every round's mockup/ folder, so the verifier compares the app with the design each round.
    let renders = null;
    if (hasMockups(mockupsOf(ctx))) {
      const r = await ctx.deps.renderMockups({ files: mockupFilesOf(mockupsOf(ctx)), outDir: path.join(shots, 'mockup'), cacheDir: path.join(ctx.worktree, ctx.s.ui.screenshotsDir, ctx.key, '.mockup-cache') });
      if (!r.ok) ctx.log(`could not render the mockups for ${st.id} (${r.error}); the verifier reads the sources`);
      renders = { ...r, text: formatRenders(r.entries) };
    }
    const mockupRenders = (renders?.entries ?? []).filter((e) => e.kind === 'screen' && e.png).map((e) => e.png);
    const task = uiVerifierTask({ key: ctx.key, st, round, maxRounds: ctx.s.maxPairRounds, diff: diffSince(worktree, base), checks: checks.output, diagnostics: diagText, webappUrl: lease.webappUrl, screenshotsDir: shots, worktree, mockups: mockupText(ctx), renders, implementerScreens: rec.mockupScreens ?? null, disputes, decisions: ctx.decisions });
    for (let attempt = 0; attempt <= ctx.config.agent.resultParseRetries; attempt++) {
      const res = await agentFor(ctx, rec, 'verifier', { role: 'uiVerifier', name: 'pair-ui-verifier', mode: 'verify', modelClass: ctx.s.roles.uiVerifier.modelClass, cwd: worktree, timeoutSec: ctx.s.timeouts.uiVerifierSec, task });
      const removed = discardChanges(worktree);
      if (removed.length) ctx.log(`discarded ${removed.length} file(s) the UI verifier left in ${path.basename(worktree)}`);
      const v = parseVerdict(res.output, { ui: true });
      if (v) return { ...v, screenshots: fs.readdirSync(shots, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(shots, e.name)), mockupRenders };
    }
    return null;
  }
}

// The implement/verify loop of one subtask. Returns { status: approved | exhausted | blocked, findings, reason }.
export async function runPair(ctx, st, opts) {
  try {
    return await pairLoop(ctx, st, opts);
  } finally {
    await releaseUi(ctx, opts.rec, opts.worktree);
  }
}

async function pairLoop(ctx, st, { worktree, branch, base, rec, others = [], implementer = 'pair-implementer', role = 'pairImplementer', startAtVerify = false }) {
  const max = ctx.s.maxPairRounds;
  const all = [];
  let findings = [];
  let screenshots = [];
  let mockupRenders = [];
  let diagText = null;
  // Disputes: id -> { disputes, reasserts }; `pending` are the implementer's disputes for the next verifier.
  const disputeState = new Map();
  let pending = { open: [], overruled: [] };
  let roundFollowUps = [];
  let skipImplementer = startAtVerify;
  const progress = (round, status) => {
    ctx.subtasks.set(st.id, { ...(ctx.subtasks.get(st.id) ?? {}), status, rounds: round, branch, worktree });
    ctx.progress();
  };

  for (let round = 1; round <= max; round++) {
    ctx.metrics.pairRounds++;
    progress(round, 'implementing');
    if (!skipImplementer) {
      const before = headSha(worktree);
      const res = await agentFor(ctx, rec, 'implementer', {
        role,
        name: implementer,
        mode: 'implement',
        modelClass: st.modelClass,
        // The planner may name a model alias (e.g. sol) for a pair implementer; the orchestrator keeps its own.
        model: role === 'pairImplementer' ? st.model ?? null : null,
        cwd: worktree,
        timeoutSec: ctx.s.timeouts.pairImplementerSec,
        task: pairImplementerTask({ key: ctx.key, storyFile: path.join(worktree, path.relative(ctx.worktree, ctx.storyFile)), st, worktree, branch, base, round, maxRounds: max, findings, screenshots, diagnostics: diagText, self: Boolean(st.self), mockups: st.verify === 'ui' ? mockupText(ctx) : null, mockupRenders, decisions: ctx.decisions }),
      });
      commitAll(worktree, `${ctx.key}: ${st.id} (round ${round})`);
      if (ctx.deps.lsp.csharpRunning(worktree) && signatureChanges(git(worktree, ['diff', before, 'HEAD']).stdout).length && !res.referencesCalls) {
        rec.sigNoRefs = true;
        ctx.metrics.signatureChangesWithoutReferences = true;
      }
      const reported = extractResult(res.output);
      if (Array.isArray(reported?.mockupScreens)) rec.mockupScreens = reported.mockupScreens.filter((x) => typeof x === 'string').slice(0, 20);
      // Nits and out-of-scope requests the implementer disputed go to the next verifier to rule on;
      // real problems outside the ticket are follow-ups for the story's run record.
      const report = parseImplementerReport(reported, findings);
      pending = openDisputes(report.disputes, disputeState);
      roundFollowUps = report.followUps.map((u) => ({ ...u, subtask: st.id, round }));
      rec.followUps.push(...roundFollowUps);
      ctx.metrics.followUps.push(...roundFollowUps);
      if (reported?.status === 'blocked') {
        const reason = reported.reason ?? 'blocked';
        rec.neededOutside = [...new Set([...String(reason).matchAll(PATHLIKE)].map((m) => m[1]).filter((f) => !st.self && scopeViolations([f], st.owns).length))];
        rec.rounds.push(roundRecord({ round, verdict: 'BLOCKED' }));
        all.push({ severity: 'blocking', category: 'blocked', subtask: st.id, round, issue: `the implementer reported the subtask blocked: ${reason}` });
        return { status: 'blocked', reason, findings: all };
      }
    } else {
      commitAll(worktree, `${ctx.key}: ${st.id} (round ${round})`);
    }
    skipImplementer = false;
    progress(round, 'verifying');

    const files = filesChanged(worktree, base);
    const outside = st.self ? [] : scopeViolations(files, st.owns);
    let diag = { available: false, errors: [], warnings: [] };
    let verdict;
    let rulings = [];
    if (!files.length) {
      verdict = { verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'blocking', category: 'scope', file: null, issue: 'no changes were committed for this subtask', fix: 'implement the subtask and commit it' }] };
    } else if (outside.length) {
      for (const f of outside) rec.outOfOwns.add(f);
      verdict = {
        verdict: 'CHANGES_REQUESTED',
        findings: outside.map((f) => ({ severity: 'blocking', category: 'scope', file: f, line: null, issue: `${f} is outside this subtask's owns (${st.owns.join(', ')})`, fix: 'restore it to its content on the story branch and commit; if the subtask really needs it, report blocked and name the file' })),
      };
    } else {
      diag = await ctx.deps.lsp.diagnostics(worktree, files);
      diagText = formatDiagnostics(diag);
      const checks = await runChecks(ctx, worktree, files);
      if (!checks.ok) {
        verdict = { verdict: 'CHANGES_REQUESTED', findings: [...diagnosticFindings(diag), { severity: 'blocking', category: 'build', file: null, issue: 'the build or the existing unit tests failed', detail: checks.output }] };
      } else {
        const disputes = formatDisputes(pending.open, pending.overruled) || null;
        const raw = st.verify === 'ui' ? await verifyUi(ctx, st, { worktree, base, round, checks, diagText, rec, disputes }) : await verifyCode(ctx, st, { worktree, base, round, checks, diagText, rec, disputes });
        let v = raw;
        if (raw) {
          const ruled = ruleDisputes({ ...raw, findings: withIds(raw.findings, { subtask: st.id, round }) }, pending.open, disputeState, pending.overruled);
          v = ruled.verdict;
          rulings = ruled.rulings;
          pending = { open: [], overruled: [] };
        }
        if (!v) {
          // No parsable verdict: the round is spent, and the next one verifies again without asking the implementer for changes.
          rec.rounds.push(roundRecord({ round, verdict: 'VERIFIER_ERROR', diagnostics: diag }));
          skipImplementer = true;
          continue;
        }
        const blockingDiag = diagnosticFindings(diag);
        verdict = blockingDiag.length ? { ...v, verdict: 'CHANGES_REQUESTED', findings: [...blockingDiag, ...v.findings] } : v;
      }
    }
    verdict = { ...verdict, findings: withIds(verdict.findings, { subtask: st.id, round }) };
    const blocking = verdict.findings.filter((f) => f.severity !== 'minor');
    rec.rounds.push(roundRecord({ round, verdict: verdict.verdict, findings: verdict.findings, diagnostics: diag, outOfOwns: outside, crossFindings: crossFindings(blocking, others), disputes: disputeCounts(rulings, roundFollowUps) }));
    // Why the pair verifier (or the harness's own checks) approved or sent the subtask back, for the retro.
    logDecision(ctx.config, verdictDecisionLog({ key: ctx.key, decisionId: ctx.decisionId, st, round, verdict, verifier: rec.verifier, ui: st.verify === 'ui', disputes: rulings, followUps: roundFollowUps }));
    roundFollowUps = [];
    if (verdict.verdict === 'APPROVED') {
      progress(round, 'approved');
      return { status: 'approved', findings: all };
    }
    all.push(...blocking.map((f) => ({ ...f, subtask: st.id, round })));
    findings = blocking;
    screenshots = verdict.screenshots ?? [];
    mockupRenders = verdict.mockupRenders ?? [];
  }
  progress(max, 'exhausted');
  return { status: 'exhausted', findings: all };
}

// ---------------------------------------------------------------------------------------------
// Subtasks: worktree, pair, escalation
// ---------------------------------------------------------------------------------------------

async function openWorktree(ctx, st) {
  const wt = createSubtaskWorktree(ctx.worktree, { prefix: ctx.s.branchPrefix, key: ctx.key, id: st.id });
  // The story is not on the branch (it lives in the ticket cache), so the subtask gets its own copy of
  // the story's cache folder at the same relative path.
  const ticket = path.dirname(ctx.storyFile);
  const rel = path.relative(ctx.worktree, ticket);
  if (fs.existsSync(ticket) && !rel.startsWith('..') && !fs.existsSync(path.join(wt.path, rel))) fs.cpSync(ticket, path.join(wt.path, rel), { recursive: true });
  if (ctx.s.prepareCmd) {
    const r = await runAsync('sh', ['-c', ctx.s.prepareCmd], { cwd: wt.path, timeoutSec: ctx.s.timeouts.checkSec, signal: ctx.abort.signal });
    if (r.status !== 0) ctx.log(`prepareCmd failed in ${path.basename(wt.path)} (exit ${r.status}); continuing`);
  }
  await ctx.deps.lsp.start(wt.path, { owns: st.owns });
  ctx.subtasks.set(st.id, { status: 'starting', branch: wt.branch, worktree: wt.path, rounds: 0 });
  ctx.progress();
  return wt;
}

async function dropWorktree(ctx, wt) {
  await ctx.deps.lsp.stop(wt.path);
  removeWorktree(ctx.worktree, wt.path, wt.branch);
}

function numstat(cwd, base) {
  const rows = git(cwd, ['diff', '--numstat', base, 'HEAD']).stdout.split('\n').filter(Boolean);
  return { files: rows.length, loc: rows.reduce((n, r) => n + r.split('\t').slice(0, 2).reduce((m, x) => m + (Number(x) || 0), 0), 0) };
}

// One subtask from worktree to approval, with at most one escalation. Returns { status, st, wt, rec, findings, reason }.
export async function runSubtask(ctx, st, others) {
  // Back-pressure (auto sizing): a new pair waits while free memory is below the reserve.
  await ctx.deps.memoryGate(`${ctx.key}--${st.id}`);
  const rec = newRec(st);
  let wt = await openWorktree(ctx, st);
  let r = await runPair(ctx, st, { worktree: wt.path, branch: wt.branch, base: wt.base, rec, others });
  if (r.status !== 'approved') {
    ctx.metrics.escalations++;
    const takeoverAllowed = ctx.metrics.takeovers < ctx.s.maxTakeovers;
    ctx.log(`subtask ${st.id} ${r.status}; escalating to the orchestrator`);
    const res = await agentFor(ctx, rec, 'orchestrator', {
      role: 'orchestrator',
      name: 'implementer',
      mode: 'implement',
      cwd: wt.path,
      timeoutSec: ctx.s.timeouts.orchestratorSec,
      task: escalationTask({ key: ctx.key, storyFile: path.join(wt.path, path.relative(ctx.worktree, ctx.storyFile)), st, worktree: wt.path, branch: wt.branch, outcome: r.status, findings: r.findings, takeoverAllowed, otherOwns: others.flatMap((o) => o.owns) }),
    });
    const d = extractResult(res.output) ?? {};
    const priorFindings = r.findings;
    logDecision(ctx.config, {
      stage: 'implement-plan',
      story: ctx.key,
      round: null,
      agent: 'implementer',
      agentVer: res.version,
      subject: 'pair-implementer',
      decision: ['rewrite', 'takeover'].includes(d.action) ? `escalation-${d.action}` : 'gave-up',
      reason: d.reason ?? null,
      decision_id: ctx.decisionId,
      subtask: st.id,
      pair_outcome: r.status,
      items: (priorFindings ?? []).slice(-20).map((f) => ({ severity: f.severity ?? null, category: f.category ?? null, file: f.file ?? null, reason: f.issue ?? f.detail ?? null })),
    });
    let next = null;
    if (['rewrite', 'takeover'].includes(d.action)) {
      const v = validateRewrite(st, d.subtask ?? {}, others, { storyText: ctx.storyText, limits: { ...limitsOf(ctx.s, ctx.config), hasMockups: hasMockups(mockupsOf(ctx)) } });
      if (!v.ok) r = { status: 'failed', reason: `the orchestrator's ${d.action} of ${st.id} is invalid: ${v.errors[0]}`, findings: priorFindings };
      else next = v.subtask;
    }
    if (next && d.action === 'rewrite') {
      rec.escalation = 'rewrite';
      await dropWorktree(ctx, wt);
      st = next;
      wt = await openWorktree(ctx, st);
      r = await runPair(ctx, st, { worktree: wt.path, branch: wt.branch, base: wt.base, rec, others });
    } else if (next && d.action === 'takeover' && takeoverAllowed) {
      rec.escalation = 'takeover';
      ctx.metrics.takeovers++;
      st = next;
      r = await runPair(ctx, st, { worktree: wt.path, branch: wt.branch, base: wt.base, rec, others, implementer: 'implementer', role: 'orchestrator', startAtVerify: true });
    } else if (r.status !== 'failed') {
      r = { status: 'failed', reason: d.action === 'takeover' ? 'the orchestrator asked for a second takeover (maxTakeovers)' : d.reason ?? 'the orchestrator gave the subtask up', findings: priorFindings };
    }
    if (r.status !== 'approved') r = { ...r, findings: [...priorFindings, ...(r.findings ?? []).filter((f) => !priorFindings.includes(f))] };
  }
  Object.assign(rec, { approved: r.status === 'approved', actual: numstat(wt.path, wt.base), st });
  return { ...r, st, wt, rec };
}

function writeSubtaskRun(ctx, rec) {
  const st = rec.st;
  record(
    ctx,
    SUBTASK_RUNS_FILE,
    subtaskRunRecord({
      ts: nowIso(),
      key: ctx.key,
      decisionId: ctx.decisionId,
      subtaskId: st.id,
      implementer: rec.implementer,
      verifier: rec.verifier,
      modelClass: st.modelClass,
      verify: st.verify,
      maxRounds: ctx.s.maxPairRounds,
      rounds: rec.rounds,
      approved: rec.approved,
      escalation: rec.escalation,
      filesNeededOutsideOwns: [...new Set([...rec.neededOutside, ...rec.outOfOwns])],
      mergeConflictFiles: rec.mergeConflictFiles,
      expected: { files: st.decision?.expectedFiles ?? null, loc: st.decision?.expectedLoc ?? null },
      actual: rec.actual,
      wallClockSec: Math.round((Date.now() - rec.started) / 1000),
      agentRuns: rec.agentRuns,
      leaseWaitSec: rec.leaseWaitSec,
      lspCalls: rec.lspCalls,
      signatureChangesWithoutReferences: rec.sigNoRefs,
      usage: rec.usage,
      followUps: rec.followUps,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------------------------

export async function mergeSubtask(ctx, st, wt, rec) {
  const r = git(ctx.worktree, ['merge', '--no-ff', '--no-edit', '-m', `${ctx.key}: Merge subtask ${st.id}`, wt.branch], { env: commitEnv });
  if (r.status !== 0) {
    const files = unmergedFiles(ctx.worktree);
    rec.mergeConflictFiles = files;
    if (!files.length) {
      git(ctx.worktree, ['merge', '--abort']);
      return { ok: false, reason: `merging ${wt.branch} failed: ${tail(r.stderr || r.stdout, 300)}` };
    }
    ctx.log(`merging ${st.id} conflicts in ${files.join(', ')}; asking the orchestrator to resolve them`);
    await callAgent(ctx, { role: 'orchestrator', name: 'implementer', mode: 'implement', step: `merge ${st.id}`, cwd: ctx.worktree, timeoutSec: ctx.s.timeouts.orchestratorSec, task: conflictTask({ key: ctx.key, worktree: ctx.worktree, branch: ctx.branch, subtaskBranch: wt.branch, st, files }) });
    const left = unmergedFiles(ctx.worktree);
    if (left.length || /<<<<<<< /.test(git(ctx.worktree, ['diff', 'HEAD', '--', ...files]).stdout)) {
      git(ctx.worktree, ['merge', '--abort']);
      return { ok: false, reason: `the merge conflicts of subtask ${st.id} in ${files.join(', ')} were not resolved` };
    }
    if (mergeInProgress(ctx.worktree)) {
      git(ctx.worktree, ['add', '-A', '--', '.', ':!graphify-out'], { env: commitEnv });
      git(ctx.worktree, ['commit', '-q', '--no-edit'], { env: commitEnv });
    }
    const checks = await runChecks(ctx, ctx.worktree, files);
    if (!checks.ok) ctx.integrationNotes.push(`The build failed after resolving the merge conflicts of subtask ${st.id}:\n${tail(checks.output, 2000)}`);
  }
  const diag = await ctx.deps.lsp.diagnostics(ctx.worktree, filesChanged(ctx.worktree, `${headSha(ctx.worktree)}^1`));
  if (diag.errors.length) ctx.integrationNotes.push(`Language server errors after merging subtask ${st.id}:\n${formatDiagnostics({ ...diag, warnings: [] })}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------------------------

const failure = (outcome, reason, findings = []) => ({ ok: false, outcome, reason, findings });

export async function orchestrate(ctx) {
  try {
    const planned = await planStory(ctx);
    if (planned.fail) return failure(planned.fail, planned.reason, (planned.findings ?? []).map((e) => ({ issue: e })));
    const plan = planned.plan;
    ctx.metrics.mode = plan.mode;
    ctx.log(`plan ${ctx.decisionId.slice(0, 8)}: ${plan.mode}${plan.mode === 'delegate' ? ` (${plan.subtasks.map((s) => `${s.id}:${s.modelClass}/${s.verify}`).join(', ')})` : ''}`);
    ctx.progress();
    return plan.mode === 'self' ? await runSelf(ctx, plan) : await runDelegated(ctx, plan);
  } catch (error) {
    if (error instanceof LimitError) return failure(error.outcome, error.message);
    throw error;
  }
}

// Also the epic foundation unit (lib/epic.mjs): one verifier pair the orchestrator implements itself.
export async function runSelf(ctx, plan) {
  const st = plan.subtasks[0];
  const rec = newRec(st);
  const base = headSha(ctx.worktree);
  ctx.subtasks.set(st.id, { status: 'starting', branch: ctx.branch, worktree: ctx.worktree, rounds: 0 });
  try {
    const r = await runPair(ctx, st, { worktree: ctx.worktree, branch: ctx.branch, base, rec, implementer: 'implementer', role: 'orchestrator' });
    Object.assign(rec, { approved: r.status === 'approved', actual: numstat(ctx.worktree, base) });
    if (r.status === 'approved') return { ok: true, mode: 'self', plan };
    return failure(r.status === 'blocked' ? 'blocked' : 'pair-exhausted', r.status === 'blocked' ? r.reason : `the story was not approved by its verifier after ${ctx.s.maxPairRounds} rounds (self mode)`, r.findings);
  } finally {
    rec.actual ??= numstat(ctx.worktree, base);
    writeSubtaskRun(ctx, rec);
  }
}

async function runDelegated(ctx, plan) {
  const order = topoOrder(plan.subtasks);
  const state = new Map(order.map((s) => [s.id, 'pending']));
  const done = new Map(); // id -> runSubtask result
  const running = new Map();
  let failed = null;
  const fail = (f) => {
    if (failed) return;
    failed = f;
    ctx.abort.abort();
  };

  while (true) {
    if (!failed) {
      for (const st of order) {
        if (running.size >= ctx.s.maxConcurrentPairs) break;
        if (state.get(st.id) !== 'pending' || !st.dependsOn.every((d) => state.get(d) === 'merged')) continue;
        state.set(st.id, 'running');
        const others = plan.subtasks.filter((o) => o.id !== st.id);
        running.set(
          st.id,
          runSubtask(ctx, st, others).then(
            (r) => [st, r],
            (error) => [st, { status: 'error', error }],
          ),
        );
      }
    }
    if (!running.size) break;
    const [st, r] = await Promise.race(running.values());
    running.delete(st.id);
    // An approved subtask's record waits for its merge (it carries the merge conflicts).
    if (r.rec && r.status !== 'approved') writeSubtaskRun(ctx, r.rec);
    if (r.status === 'error') {
      if (r.error instanceof LimitError) fail(failure(r.error.outcome, r.error.message));
      else if (!(r.error instanceof AbortedError)) fail(failure('error', `subtask ${st.id}: ${r.error.message}`));
      state.set(st.id, 'failed');
      continue;
    }
    if (r.status !== 'approved') {
      state.set(st.id, 'failed');
      ctx.subtasks.set(st.id, { ...(ctx.subtasks.get(st.id) ?? {}), status: 'failed' });
      fail(failure('pair-exhausted', `subtask ${st.id} was not approved${r.reason ? `: ${r.reason}` : ` after ${ctx.s.maxPairRounds} rounds and an escalation`}`, r.findings));
      continue;
    }
    state.set(st.id, 'approved');
    done.set(st.id, r);
    // Merge serially in plan/dependency order: a subtask merges once every subtask before it has.
    for (const o of order) {
      if (failed) break;
      if (state.get(o.id) === 'merged') continue;
      if (state.get(o.id) !== 'approved') break;
      const res = done.get(o.id);
      const m = await mergeSubtask(ctx, res.st, res.wt, res.rec);
      writeSubtaskRun(ctx, res.rec);
      res.recorded = true;
      if (!m.ok) {
        fail(failure('merge-conflict', m.reason, res.rec.mergeConflictFiles.map((f) => ({ subtask: o.id, file: f, issue: 'merge conflict' }))));
        break;
      }
      state.set(o.id, 'merged');
      ctx.subtasks.set(o.id, { ...(ctx.subtasks.get(o.id) ?? {}), status: 'merged', worktree: null });
      await dropWorktree(ctx, res.wt);
      ctx.progress();
    }
  }
  for (const res of done.values()) if (!res.recorded) writeSubtaskRun(ctx, res.rec);
  // Subtask worktrees of a failed story stay for debugging; their language servers do not.
  for (const [id, st] of ctx.subtasks) if (st.worktree && st.worktree !== ctx.worktree && state.get(id) !== 'merged') await ctx.deps.lsp.stop(st.worktree);
  ctx.progress();
  if (failed) return failed;
  if ([...state.values()].some((v) => v !== 'merged')) return failure('error', `subtasks ${[...state].filter(([, v]) => v !== 'merged').map(([k]) => k).join(', ')} never ran (unsatisfiable dependencies)`);
  return { ok: true, mode: 'delegate', plan, integrationNotes: ctx.integrationNotes };
}
