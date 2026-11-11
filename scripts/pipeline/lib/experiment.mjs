// Delivery experiments: `pipeline experiment run --epic <EPIC> --modes epic,story [--repeat N]` runs the
// same epic once per arm (a delivery mode, repeated), each in its own worktree and branches from the same
// base commit, with every record tagged (experiment_id, experiment_arm, delivery), the board, lessons and
// PRs off. A shared grading step then runs the pooled epic-level e2e tests of every arm against every
// arm's result and scores each arm with the PR check (no fixer). `pipeline experiment report <id>`
// compares the arms. See docs/ai-pipeline/experiments.md.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { labelDecisions } from '../../implement/lib/decisions.mjs';
import { INSTALL_ROOT } from './config.mjs';
import { git } from './git.mjs';
import { epicTickets, loadTicket } from './tickets.mjs';
import { summarizeUsage } from './usage.mjs';
import { log, nowIso, readJson, run, writeJson } from './util.mjs';

const IMPLEMENT_CLI = path.join(INSTALL_ROOT, 'scripts/implement/implement.mjs');
const PR_CHECK_CLI = path.join(INSTALL_ROOT, 'scripts/pr-check/pr-check.mjs');
export const MODES = ['epic', 'story'];
const METRICS = ['token-usage.jsonl', 'decisions.jsonl', 'implement-runs.jsonl', 'subtask-runs.jsonl', 'decision-outcomes.jsonl'];

export const experimentDir = (config, id) => path.join(config.root, config.stateDir, 'experiments', id);
const stateFile = (config, id) => path.join(experimentDir(config, id), 'experiment.json');
export const loadExperiment = (config, id) => readJson(stateFile(config, id), null);
const saveExperiment = (config, exp) => writeJson(stateFile(config, exp.id), { ...exp, updatedAt: nowIso() });

export const newExperimentId = (now = new Date()) => `${now.toISOString().slice(0, 16).replace(/[-:T]/g, '').slice(0, 12)}-${randomBytes(2).toString('hex')}`;

// The arms of an experiment: every mode, `repeat` times, each with its branch and worktree.
export function planArms(config, { id, modes, repeat = 1 }) {
  const dir = path.resolve(config.root, '..', `${path.basename(config.root)}-experiments`);
  const arms = [];
  for (let n = 1; n <= repeat; n++) for (const mode of modes) arms.push({ name: `${mode}-${n}`, mode, n, branch: `exp/${id}-${mode}-${n}`, worktree: path.join(dir, `${id}-${mode}-${n}`), prefix: `exp/${id}/${mode}-${n}/` });
  return arms;
}

// The environment of one arm: tagged records, its own branch names, no board, lessons or PRs.
export const armEnv = (exp, arm, base = process.env) => {
  const env = {
    ...base,
    PIPELINE_ROOT: arm.worktree,
    PIPELINE_EXPERIMENT_ID: exp.id,
    PIPELINE_EXPERIMENT_ARM: arm.name,
    PIPELINE_DELIVERY: arm.mode,
    PIPELINE_BOARD: 'off',
    PIPELINE_LESSONS: 'off',
    PIPELINE_NO_PR: '1',
    PIPELINE_TICKETS_OFFLINE: '1',
    IMPLEMENT_BRANCH_PREFIX: `${arm.prefix}feat-`,
    IMPLEMENT_EPIC_BRANCH_PREFIX: `${arm.prefix}epic-`,
    IMPLEMENT_BUGFIX_BRANCH_PREFIX: `${arm.prefix}bugfix-`,
  };
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  return env;
};

// Creates the arm's worktree on its branch at the base commit, with the epic's tickets in its cache.
export function prepareArm(config, arm, { baseSha, ticketDirs }) {
  if (!fs.existsSync(arm.worktree)) {
    fs.mkdirSync(path.dirname(arm.worktree), { recursive: true });
    const r = git(config.root, ['worktree', 'add', '-q', '-b', arm.branch, arm.worktree, baseSha]);
    if (r.status !== 0) throw new Error(`git worktree add ${arm.worktree} failed: ${r.stderr}`);
  }
  for (const dir of ticketDirs) {
    const dst = path.join(arm.worktree, path.relative(config.root, dir));
    if (fs.existsSync(dir) && !fs.existsSync(dst)) fs.cpSync(dir, dst, { recursive: true });
  }
}

// Runs one arm: `implement run --epic <EPIC> --delivery <mode>` in the arm worktree. Resolves with the
// exit code; the log goes to the experiment folder.
function runArmProcess(config, exp, arm) {
  const logFile = path.join(experimentDir(config, exp.id), `${arm.name}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const args = [IMPLEMENT_CLI, 'run', '--epic', exp.epic, '--delivery', arm.mode, '--base', arm.branch, '--parallel', String(exp.parallel ?? 'auto')];
  const child = spawn(process.execPath, args, { cwd: arm.worktree, stdio: ['ignore', fd, fd], env: armEnv(exp, arm) });
  fs.closeSync(fd);
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, log: path.relative(config.root, logFile) })));
}

// The branches holding an arm's result: the epic branch(es) of an epic arm (its epic run state), or
// every story branch that finished done (its implement run records), in key order.
export function resultBranches(armRoot, stateDir = '.agent-state') {
  const dir = path.join(armRoot, stateDir, 'implement');
  const epics = path.join(dir, 'epics');
  const out = [];
  if (fs.existsSync(epics)) {
    for (const f of fs.readdirSync(epics).filter((x) => x.endsWith('.json') && !x.endsWith('.note.json'))) {
      const s = readJson(path.join(epics, f), null);
      for (const u of Object.values(s?.units ?? {})) if (u.branch) out.push(u.branch);
    }
  }
  if (!out.length && fs.existsSync(dir)) {
    const keys = fs.readdirSync(dir).filter((f) => /^[A-Z][A-Z0-9]*-\d+\.json$/.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    for (const f of keys) {
      const r = readJson(path.join(dir, f), null);
      if (r?.outcome === 'done' && r.branch) out.push(r.branch);
    }
  }
  return [...new Set(out)];
}

// Merges the arm's result branches into the arm branch, so every arm has one tree to grade. A conflict
// (stories built apart that do not fit together) is recorded and that branch is left out.
export function integrateArm(arm, branches) {
  const merged = [];
  const conflicts = [];
  for (const b of branches) {
    const r = git(arm.worktree, ['merge', '--no-ff', '--no-edit', '-q', '-m', `experiment: merge ${b}`, b], { env: { ...process.env, PIPELINE_DISABLE: '1' } });
    if (r.status === 0) merged.push(b);
    else {
      git(arm.worktree, ['merge', '--abort']);
      conflicts.push(b);
    }
  }
  return { merged, conflicts };
}

export const defaultExperimentDeps = {
  runArm: runArmProcess,
  // A pooled e2e spec against an arm's result: `experiment.testCmd` with {file}; passes on exit 0.
  runTest: (config, arm, file) => run('sh', ['-c', (config.experiment?.testCmd ?? 'npx playwright test -c playwright.teststack.config.ts {file}').replace('{file}', JSON.stringify(file))], { cwd: arm.worktree, timeoutSec: config.experiment?.testTimeoutSec ?? 1800 }).status === 0,
  // The PR check (report only, no fixer) of all the epic's tickets against the arm's whole diff.
  prCheck: (config, arm, keys, base) => {
    const r = run(process.execPath, [PR_CHECK_CLI, 'run', '--stories', keys.join(','), '--base', base, '--no-fix', '--json'], { cwd: arm.worktree, env: armEnv({ id: 'grading' }, arm), timeoutSec: 14400 });
    try {
      const o = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      return { verdict: o.verdict, score: o.score, upheld: (o.openFindings ?? []).length };
    } catch {
      return { verdict: 'ERROR', score: null, upheld: null };
    }
  },
};

export async function runExperiment(config, { epic, modes = MODES, repeat = 1, sequential = false, base = config.baseRef, parallel = 'auto', grade = true, deps = {} }) {
  const d = { ...defaultExperimentDeps, ...deps };
  for (const m of modes) if (!MODES.includes(m)) throw new Error(`unknown mode "${m}"; use ${MODES.join(', ')}`);
  // Tickets come from the board once, here; the arms then run offline from their copies.
  const tickets = epicTickets(config, epic);
  if (!tickets.length) throw new Error(`epic ${epic} has no stories on the board (or in the ticket cache)`);
  const epicTicket = tickets[0].epic ? loadTicket(config, tickets[0].epic, { fetch: false }) : null;
  const baseSha = git(config.root, ['rev-parse', base]).stdout.trim();
  if (!baseSha) throw new Error(`base ${base} does not exist`);
  const id = newExperimentId();
  const exp = { id, epic, epicKey: epicTicket?.key ?? null, base, baseSha, modes, repeat, sequential, parallel, tickets: tickets.map((t) => t.key), startedAt: nowIso(), arms: planArms(config, { id, modes, repeat }) };
  saveExperiment(config, exp);
  const ticketDirs = [...(epicTicket ? [config.abs(epicTicket.dir)] : []), ...tickets.map((t) => config.abs(t.dir))];
  for (const arm of exp.arms) prepareArm(config, arm, { baseSha, ticketDirs });
  log(`experiment ${id}: ${exp.arms.length} arm(s) of ${epic} from ${baseSha.slice(0, 12)}${sequential ? ', one after another' : ', in parallel'}`);

  const runOne = async (arm) => {
    const t0 = Date.now();
    arm.startedAt = nowIso();
    const r = await d.runArm(config, exp, arm);
    arm.finishedAt = nowIso();
    arm.wallClockSec = Math.round((Date.now() - t0) / 1000);
    arm.exitCode = r.code;
    arm.log = r.log ?? null;
    arm.integration = integrateArm(arm, resultBranches(arm.worktree, config.stateDir));
    log(`experiment ${id}: arm ${arm.name} finished (exit ${r.code}, ${arm.wallClockSec}s; merged ${arm.integration.merged.length}, conflicts ${arm.integration.conflicts.length})`);
    saveExperiment(config, exp);
  };
  if (sequential) for (const arm of exp.arms) await runOne(arm);
  else await Promise.all(exp.arms.map(runOne));
  exp.finishedAt = nowIso();
  saveExperiment(config, exp);
  if (grade) await gradeExperiment(config, id, { deps: d });
  return loadExperiment(config, id);
}

// Files on a branch (since the base) that carry epic-level test case ids (TC-EPIC-<n>-NN).
export function epicTestFiles(root, branch, baseSha) {
  const changed = git(root, ['diff', '--name-only', '--diff-filter=AM', `${baseSha}..${branch}`]).stdout.split('\n').filter(Boolean);
  return changed.filter((f) => /\.(spec|test)\.[cm]?[jt]s$|Tests?\.cs$/.test(f) && /TC-EPIC-\d+-\d+/.test(git(root, ['show', `${branch}:${f}`]).stdout));
}

// The pooled copy of another arm's spec: `checkout.spec.ts` from arm epic-1 -> `checkout.from-epic-1.spec.ts`.
export const pooledName = (file, armName) => file.replace(/(\.(?:spec|test)\.[cm]?[jt]s|\.cs)$/, `.from-${armName}$1`);

export async function gradeExperiment(config, id, { deps = {} } = {}) {
  const d = { ...defaultExperimentDeps, ...deps };
  const exp = loadExperiment(config, id);
  if (!exp) throw new Error(`no experiment ${id}`);
  const pool = exp.arms.flatMap((a) => epicTestFiles(config.root, a.branch, exp.baseSha).map((file) => ({ arm: a.name, file, text: git(config.root, ['show', `${a.branch}:${file}`]).stdout })));
  for (const arm of exp.arms) {
    const tests = [];
    const copied = [];
    for (const t of pool) {
      const file = t.arm === arm.name ? t.file : pooledName(t.file, t.arm);
      if (t.arm !== arm.name) {
        fs.mkdirSync(path.dirname(path.join(arm.worktree, file)), { recursive: true });
        fs.writeFileSync(path.join(arm.worktree, file), t.text);
        copied.push(file);
      }
      tests.push({ file, from: t.arm, passed: Boolean(await d.runTest(config, arm, file)) });
    }
    for (const f of copied) fs.rmSync(path.join(arm.worktree, f), { force: true });
    const prCheck = await d.prCheck(config, arm, exp.tickets, exp.baseSha);
    arm.grade = { tests, passed: tests.filter((t) => t.passed).length, total: tests.length, prCheck, upheld: prCheck.upheld ?? null, gradedAt: nowIso() };
    log(`experiment ${id}: arm ${arm.name} graded (${arm.grade.passed}/${arm.grade.total} shared tests, ${arm.grade.upheld} upheld PR check finding(s))`);
  }
  saveExperiment(config, exp);
  return exp;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

// Every metrics record an arm wrote: committed on any of its branches, or still on disk in its
// worktree, de-duplicated, then only this experiment's and this arm's.
export function armRecords(root, exp, arm, metricsDir = '.agent-metrics') {
  const refs = git(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/exp/${exp.id}-${arm.name}`, `refs/heads/${arm.prefix}`]).stdout.split('\n').filter(Boolean);
  const out = Object.fromEntries(METRICS.map((f) => [f, new Map()]));
  for (const f of METRICS) {
    const texts = refs.map((ref) => git(root, ['show', `${ref}:${metricsDir}/${f}`]).stdout);
    if (arm.worktree && fs.existsSync(path.join(arm.worktree, metricsDir, f))) texts.push(fs.readFileSync(path.join(arm.worktree, metricsDir, f), 'utf8'));
    for (const line of texts.join('\n').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.experiment_id === exp.id && (r.experiment_arm ?? arm.name) === arm.name) out[f].set(line, r);
      } catch {
        // not a record
      }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([f, m]) => [f, [...m.values()]]));
}

// Usage rows by bucket: implementation (the orchestrator implementing, pair implementers), verification
// (pair verifiers) and overhead (planning, review, QE, PR check, epic plan).
export function bucketOf(r) {
  if (r.stage === 'implement-pair') return 'implement';
  if (r.stage === 'implement') return r.step === 'plan' || r.step === 'epic-plan' ? 'overhead' : 'implement';
  if (r.stage === 'implement-verify' || r.stage === 'implement-ui-verify') return 'verify';
  return 'overhead';
}

// Files created by an earlier ticket and modified by a later one, from the arm's git history
// (`git log --reverse --no-merges --name-status`). Commits are attributed by their `<KEY>:` prefix.
export function reworkRate(commits) {
  const createdBy = new Map();
  const reworked = new Set();
  for (const c of commits) {
    const key = /^([A-Z][A-Z0-9]*-\d+):/.exec(c.subject)?.[1];
    if (!key) continue;
    for (const { status, file } of c.files) {
      // Metrics logs are appended by every ticket; they are bookkeeping, not rework.
      if (file.startsWith('.agent-metrics/')) continue;
      if (status === 'A' && !createdBy.has(file)) createdBy.set(file, key);
      else if (status === 'M' && createdBy.has(file) && createdBy.get(file) !== key) reworked.add(file);
    }
  }
  return { created: createdBy.size, reworked: reworked.size, rate: createdBy.size ? Math.round((reworked.size / createdBy.size) * 1000) / 1000 : 0 };
}

export function parseLog(text) {
  const commits = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) commits.push({ subject: line.slice(2), files: [] });
    else if (/^[AMDRC]\d*\t/.test(line) && commits.length) {
      const parts = line.split('\t');
      commits.at(-1).files.push({ status: parts[0][0], file: parts.at(-1) });
    }
  }
  return commits;
}

const add = (rows, field) => rows.reduce((n, r) => n + (Number(r[field]) || 0), 0);

// One arm's numbers. `records` from armRecords, `log` the parsed history of its result.
export function summarizeArm(arm, records, commits = [], thresholds = {}) {
  const usage = records['token-usage.jsonl'];
  const total = summarizeUsage(usage);
  const buckets = { implement: 0, verify: 0, overhead: 0 };
  for (const r of usage) {
    if (!r.measured || !r.tokens) continue;
    const t = r.tokens;
    buckets[bucketOf(r)] += (t.input ?? 0) + (t.output ?? 0) + (t.cache_read ?? 0) + (t.cache_write_5m ?? 0) + (t.cache_write_1h ?? 0);
  }
  const runs = records['implement-runs.jsonl'];
  const labels = labelDecisions({ decisions: records['decisions.jsonl'], runs: records['subtask-runs.jsonl'], outcomes: records['decision-outcomes.jsonl'] }, thresholds);
  const labelCounts = {};
  for (const row of labels) for (const l of row.labels) labelCounts[l] = (labelCounts[l] ?? 0) + 1;
  const all = buckets.implement + buckets.verify + buckets.overhead;
  return {
    arm: arm.name,
    mode: arm.mode,
    costUsd: total.costUsd,
    tokens: total.tokens.total,
    premiumRequests: total.premiumRequests,
    agentRuns: total.runs,
    wallClockSec: arm.wallClockSec ?? null,
    tokensByBucket: buckets,
    overheadShare: all ? Math.round((buckets.overhead / all) * 1000) / 1000 : null,
    stories: runs.length,
    done: runs.filter((r) => r.outcome === 'done').length,
    pairRounds: add(runs, 'pair_rounds'),
    escalations: add(runs, 'escalations'),
    bugFixCycles: add(runs, 'bug_fix_cycles'),
    rework: reworkRate(commits),
    integrationConflicts: arm.integration?.conflicts?.length ?? 0,
    sharedTests: arm.grade ? { passed: arm.grade.passed, total: arm.grade.total, rate: arm.grade.total ? Math.round((arm.grade.passed / arm.grade.total) * 1000) / 1000 : null } : null,
    upheldFindings: arm.grade?.upheld ?? null,
    decisionLabels: labelCounts,
  };
}

export function experimentReport(config, id) {
  const exp = loadExperiment(config, id);
  if (!exp) throw new Error(`no experiment ${id}`);
  const arms = exp.arms.map((arm) => {
    const commits = parseLog(git(config.root, ['log', '--reverse', '--no-merges', '--format=@@%s', '--name-status', `${exp.baseSha}..${arm.branch}`]).stdout);
    return summarizeArm(arm, armRecords(config.root, exp, arm, config.metricsDir), commits, config.implement?.decisions);
  });
  return { id, epic: exp.epic, baseSha: exp.baseSha, modes: exp.modes, repeat: exp.repeat, arms, caveats: CAVEATS };
}

export const CAVEATS = [
  'n is small: one epic, a few repeats per mode. Treat differences as hints, not results; repeat with --repeat and other epics before deciding.',
  'Agents are nondeterministic: two runs of the same arm differ. Compare the spread between repeats of one mode with the gap between modes.',
  'Parallel arms share the machine (agent slots, stack slots, builds), so wall clock depends on what ran alongside; --sequential isolates it at the cost of time.',
  'Shared tests come only from arms that wrote epic-level e2e tests (epic delivery); story-delivery arms are graded on them but contribute none.',
  'Overhead share counts tokens: planning, review, QE, PR check and the epic plan over all tokens; verification (pair verifiers) is shown apart.',
];

const fmt = (v, digits = 0) => (v == null ? '-' : typeof v === 'number' ? v.toFixed(digits) : String(v));

export function formatReport(rep) {
  const cols = [
    ['Arm', (a) => a.arm],
    ['Cost $', (a) => fmt(a.costUsd, 2)],
    ['Tokens', (a) => fmt(a.tokens)],
    ['Prem. req', (a) => fmt(a.premiumRequests)],
    ['Wall min', (a) => fmt(a.wallClockSec == null ? null : a.wallClockSec / 60, 1)],
    ['Overhead', (a) => (a.overheadShare == null ? '-' : `${Math.round(a.overheadShare * 100)}%`)],
    ['Agent runs', (a) => fmt(a.agentRuns)],
    ['Pair rnds', (a) => fmt(a.pairRounds)],
    ['Escal.', (a) => fmt(a.escalations)],
    ['Bug fixes', (a) => fmt(a.bugFixCycles)],
    ['Rework', (a) => `${Math.round(a.rework.rate * 100)}% (${a.rework.reworked}/${a.rework.created})`],
    ['Shared tests', (a) => (a.sharedTests ? `${a.sharedTests.passed}/${a.sharedTests.total}` : '-')],
    ['Upheld', (a) => fmt(a.upheldFindings)],
    ['Done', (a) => `${a.done}/${a.stories}`],
  ];
  const widths = cols.map(([h, f]) => Math.max(h.length, ...rep.arms.map((a) => String(f(a)).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  const out = [`Experiment ${rep.id}: ${rep.epic} from ${rep.baseSha.slice(0, 12)} (${rep.modes.join(' vs ')}, ${rep.repeat} repeat(s))`, '', line(cols.map(([h]) => h)), ...rep.arms.map((a) => line(cols.map(([, f]) => f(a))))];
  out.push('', 'Decision labels:');
  for (const a of rep.arms) out.push(`  ${a.arm}: ${Object.entries(a.decisionLabels).map(([l, n]) => `${l} ${n}`).join(', ') || 'none'}${a.integrationConflicts ? `; ${a.integrationConflicts} branch(es) did not merge into the arm's result` : ''}`);
  out.push('', 'Caveats:', ...rep.caveats.map((c) => `- ${c}`));
  return out.join('\n');
}
