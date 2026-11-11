import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDefinition, runAgent } from '../../pipeline/lib/agents.mjs';
import { spawnBackground } from '../../pipeline/lib/background.mjs';
import { formatBugs, logDecision, normalizeBugs } from '../../pipeline/lib/decisions.mjs';
import { git, implChanges } from '../../pipeline/lib/git.mjs';
import { readEvidence, formatEvidence } from './evidence.mjs';
import { onLeasedSlot } from './slots.mjs';
import {
  INDEX,
  automationFiles,
  automationSha,
  caseDecisions,
  planContentSha,
  tidyPlan,
  planStatus,
  precheckPlan,
  readPlan,
  stampIndex,
} from './plans.mjs';
import { clearEscalation, escalate, lockFile, logFile, loadState, metricsFile, updateState } from '../../pipeline/lib/state.mjs';
import { RECOVERY_DONE, nextAttempt, runDied } from '../../pipeline/lib/recovery.mjs';
import { casePrefix, storySha } from '../../pipeline/lib/stories.mjs';
import { storyVersion } from '../../board/lib/source.mjs';
import { acquireLock, appendJsonl, extractResult, lockHolder, log, nowIso, releaseLock, run, runAsync, selfProcess, sleep, tail } from '../../pipeline/lib/util.mjs';
import { PRODUCER, formatGaps, runVerifier } from './verify.mjs';

const QE_SCRIPT = fileURLToPath(new URL('../qe.mjs', import.meta.url));

const fence = (text, lang = '') => `\`\`\`\`${lang}\n${text.replace(/\r\n/g, '\n').trimEnd()}\n\`\`\`\``;
const readRel = (config, rel) => fs.readFileSync(path.join(config.root, rel), 'utf8');

function langFor(file) {
  if (file.endsWith('.cs')) return 'csharp';
  if (file.endsWith('.ts')) return 'ts';
  if (file.endsWith('.yaml') || file.endsWith('.yml')) return 'yaml';
  if (file.endsWith('.sql')) return 'sql';
  return '';
}

function logPrecheck(config, stage, story, round, errors) {
  appendJsonl(metricsFile(config, 'precheck-failures.jsonl'), {
    ts: nowIso(),
    stage,
    story: story.key,
    round,
    agent_prompt_ver: agentDefinition(config, PRODUCER[stage]).version,
    errors,
  });
}

// The linters the repo's pre-commit hook runs (config precheck.lint, by file extension), so a lint error in
// the agent's files comes back to it as feedback instead of failing the harness's commit afterwards. A
// linter that is not installed in the checkout (a local node_modules/.bin path that is missing) is skipped,
// like the hook does.
export function lintFiles(config, files, { runner = run } = {}) {
  const errors = [];
  for (const [ext, template] of Object.entries(config.precheck.lint ?? {})) {
    const matching = files.filter((f) => f.endsWith(ext));
    if (!matching.length || !template?.length) continue;
    if (template[0].includes('/') && !fs.existsSync(path.join(config.root, template[0]))) continue;
    const argv = expand(template, { files: matching });
    const result = runner(argv[0], argv.slice(1), { cwd: config.root, timeoutSec: 300 });
    if (result.status !== 0 && result.status !== 127) errors.push(`\`${argv[0]}\` (the commit hook's linter) failed on ${matching.join(', ')}:\n${tail(`${result.stdout ?? ''}${result.stderr ?? ''}`, 3000)}`);
  }
  return errors;
}

// Finds the version of the story the plan was written against (the ticket cache keeps every version it
// fetched, by story sha; else the issue's edit history) and diffs it with the current story, so an update
// can edit the affected cases in place instead of rewriting the plan.
export function storyDiffSince(config, story, oldSha, { version = storyVersion } = {}) {
  if (!oldSha) return null;
  const current = config.abs(story.file);
  if (!fs.existsSync(current) || storySha(fs.readFileSync(current, 'utf8')) === oldSha) return null;
  const old = version(config, story.key, oldSha);
  if (old == null) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'story-diff-'));
  try {
    const before = path.join(tmp, 'story.md');
    fs.writeFileSync(before, old);
    const diff = git(config.root, ['diff', '--no-index', '--no-ext-diff', '--', before, current]).stdout;
    return diff ? diff.replaceAll(before, `${story.key}@${oldSha}`).replaceAll(current, story.file) : null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Workflow 1: story -> integration test plan, verified by a fresh verifier until it scores 10/10
// ---------------------------------------------------------------------------------------------

function planTask(config, story, { mode, reasons, storyDiff, feedback }) {
  const lines = [
    `Story: ${story.key} (${story.file})`,
    `Plan directory: ${story.planDir}`,
    `Mode: ${mode}${reasons?.length ? ` (${reasons.join('; ')})` : ''}`,
    `Case id format: ${casePrefix(story.key)}NN (two or more digits)`,
    `Allowed sad-path values: ${config.categories.sadPathSubtypes.join(', ')}`,
    '',
    '### Story',
    '',
    fence(readRel(config, story.file), 'markdown'),
  ];
  if (mode === 'update') {
    lines.push('', '### What changed in the story since the plan was written', '');
    lines.push(storyDiff ? fence(storyDiff, 'diff') : 'No diff is available; compare the story with the existing case files yourself.');
    lines.push('', 'Update the existing plan in place: keep the ids of cases that still apply, edit the ones affected by the change, delete cases the story no longer supports, and add new cases with the next unused number.');
  }
  if (feedback) lines.push('', '### Fix every item from the previous round', '', feedback);
  return lines.join('\n');
}

function planVerifierTask(config, story, plan) {
  const lines = [
    `Story: ${story.key}`,
    `Required score: ${config.loops.requiredScore}/10`,
    `Allowed categories: ${config.categories.plan.join(', ')}`,
    `Allowed missing-sad-path subtypes: ${config.categories.sadPathSubtypes.join(', ')}`,
    '',
    '### Story',
    '',
    fence(readRel(config, story.file), 'markdown'),
    '',
    `### Plan index (${story.planDir}/${INDEX})`,
    '',
    fence(plan.index?.body ?? '(missing)', 'markdown'),
    '',
    '### Case files',
  ];
  for (const c of plan.cases) lines.push('', `#### ${c.file}`, '', fence(c.text, 'markdown'));
  return lines.join('\n');
}

// Why the plan agent wrote this plan: its summary and exclusions, and each case's "## Why".
// Logged every round that passes the precheck, so it pairs with that round's verifier decision.
function logPlanDecision(config, story, round, producer, feedback) {
  const reported = extractResult(producer.output) ?? {};
  const excluded = (Array.isArray(reported.excluded) ? reported.excluded : []).map((e) =>
    e && typeof e === 'object' ? { item: e.item ?? null, reason: e.why ?? e.reason ?? null } : { item: String(e), reason: null },
  );
  logDecision(config, {
    stage: 'plan',
    story: story.key,
    round,
    agent: PRODUCER.plan,
    agentVer: producer.version,
    subject: PRODUCER.plan,
    decision: 'plan-written',
    reason: reported.summary ?? null,
    trigger: round === 1 && !feedback ? 'story' : 'feedback',
    excluded,
    items: caseDecisions(readPlan(config, story)),
  });
}

export async function planLoop(config, story, { force = false, resume = false, seedFeedback = null, maxRounds = config.loops.planMaxRounds } = {}) {
  const lock = lockFile(config, story.key, 'plan');
  if (!acquireLock(lock)) {
    log(`${story.key}: plan run already in progress (pid ${lockHolder(lock)}).`);
    return { status: 'busy' };
  }
  const finished = (status, extra = {}) => updateState(config, story.key, (s) => Object.assign(s.plan, { status, pid: null, boot: null, ...RECOVERY_DONE, finishedAt: nowIso(), ...extra }));
  try {
    tidyPlan(config, story);
    const initial = planStatus(config, story);
    if (initial.state === 'verified' && !force && !seedFeedback) {
      log(`${story.key}: plan is verified and up to date.`);
      finished('verified');
      return { status: 'verified' };
    }
    const saved = resume ? loadState(config, story.key).plan.progress : null;
    updateState(config, story.key, (s) => Object.assign(s.plan, { status: 'running', ...selfProcess(), startedAt: nowIso() }));
    const mode = initial.state === 'missing' ? 'create' : 'update';
    const storyDiff = mode === 'update' ? storyDiffSince(config, story, initial.plan.index?.data['story-sha']) : null;
    let feedback = resume ? resumeFeedback('plan', saved?.feedback ?? seedFeedback) : seedFeedback;
    let consecutive = 0;
    let lastGaps = [];
    for (let round = Math.min(saved?.round ?? 1, maxRounds); round <= maxRounds; round++) {
      updateState(config, story.key, (s) => (s.plan.progress = { round, feedback }));
      log(`${story.key}: plan round ${round}/${maxRounds} (${mode})`);
      const producer = runAgent(config, {
        name: PRODUCER.plan,
        mode: 'write',
        model: config.agent.models.plan,
        timeoutSec: config.timeoutsSec.plan,
        usage: { stage: 'plan', story: story.key, round },
        task: planTask(config, story, { mode: round === 1 ? mode : 'update', reasons: initial.reasons, storyDiff, feedback }),
      });
      if (!producer.ok) {
        feedback = `The previous run ${producer.timedOut ? 'timed out' : `failed (exit ${producer.status})`}. Finish the plan.`;
        continue;
      }
      stampIndex(config, story, { 'plan-sha': undefined, 'verified-score': undefined, 'verified-at': undefined, 'verified-by': undefined });
      tidyPlan(config, story);
      const pre = precheckPlan(config, story);
      if (!pre.errors.length) pre.errors.push(...lintFiles(config, [...(pre.plan.index ? [`${story.planDir}/${INDEX}`] : []), ...pre.plan.cases.map((c) => c.file)]));
      if (pre.errors.length) {
        logPrecheck(config, 'plan', story, round, pre.errors);
        feedback = `Structural check failed:\n${pre.errors.map((e) => `- ${e}`).join('\n')}`;
        continue;
      }
      logPlanDecision(config, story, round, producer, feedback);
      let verdict;
      do {
        verdict = runVerifier(config, {
          stage: 'plan',
          story,
          round,
          producerVersion: producer.version,
          task: planVerifierTask(config, story, readPlan(config, story)),
        });
        if (verdict.error) break;
        consecutive = verdict.passed ? consecutive + 1 : 0;
      } while (verdict.passed && consecutive < config.loops.consecutivePasses);
      if (verdict.error) {
        feedback = null;
        continue;
      }
      if (verdict.passed) {
        const plan = readPlan(config, story);
        stampIndex(config, story, {
          'plan-sha': planContentSha(plan),
          'verified-score': verdict.score,
          'verified-at': nowIso(),
          'verified-by': `${PRODUCER.plan}@${producer.version}/${verdict.verifierVersion}`,
        });
        clearEscalation(config, story, 'plan');
        finished('verified', { rounds: round });
        log(`${story.key}: plan verified ${verdict.score}/10 after ${round} round(s).`);
        return { status: 'verified', rounds: round };
      }
      lastGaps = verdict.gaps;
      feedback = `The verifier scored the plan ${verdict.score}/10. Fix every gap:\n${formatGaps(verdict.gaps)}`;
    }
    escalate(config, story, 'plan', `plan did not reach ${config.loops.requiredScore}/10 in ${maxRounds} rounds`, lastGaps.length ? formatGaps(lastGaps) : feedback ?? '');
    finished('escalated');
    return { status: 'escalated' };
  } finally {
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------------------------
// Workflow 2: verified plan -> scenario + automated tests, verified until 10/10
// ---------------------------------------------------------------------------------------------

function expand(template, values) {
  return template.flatMap((part) => {
    if (part === '{files}') return values.files ?? [];
    return [part.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '')];
  });
}

export async function precheckAutomation(config, story, { skipTests = false } = {}) {
  const errors = [];
  const status = planStatus(config, story);
  if (status.state !== 'verified') errors.push(`Plan for ${story.key} is ${status.state}: ${status.reasons.join('; ')}.`);
  const planIds = new Set(status.plan.cases.map((c) => c.data.id).filter(Boolean));
  const { tests, scenarioDir, scenario } = automationFiles(config, story);
  const covered = new Set([...tests.values()].flatMap((ids) => [...ids]));
  for (const id of planIds) if (!covered.has(id)) errors.push(`${id} has no automated test (put the id in the test name).`);
  for (const id of covered) if (!planIds.has(id)) errors.push(`${id} is referenced by tests but is not in the plan (remove or rename it).`);
  if (!scenario.some((f) => /scenario\.ya?ml$/.test(f))) errors.push(`Missing scenario: create ${scenarioDir}/scenario.yaml.`);

  for (const [file] of tests) {
    if (!file.endsWith('.cs')) continue;
    const framework = testFramework(config, projectOf(file));
    if (!storyTag(framework, story.key).test(readRel(config, file))) {
      errors.push(`${file}: tag the story's tests with ${storyTagText(framework, story.key)} so they can be filtered (${projectOf(file)} uses ${framework}).`);
    }
  }
  if (errors.length) return { errors, tests };
  errors.push(...lintFiles(config, [...tests.keys()]));

  const validate = config.precheck.validateScenario;
  if (validate?.length && fs.existsSync(path.join(config.root, validate[0]))) {
    const result = run(validate[0], expand(validate.slice(1), { scenario: story.scenario }), { cwd: config.root, timeoutSec: 600 });
    if (result.status !== 0) errors.push(`Scenario validation failed:\n${tail(result.stdout + result.stderr, 3000)}`);
  }
  if (skipTests || !config.precheck.runTests || errors.length) return { errors, tests };

  const specFiles = [...tests.keys()].filter((f) => f.endsWith('.ts'));
  const projects = [...new Set([...tests.keys()].filter((f) => f.endsWith('.cs')).map(projectOf))];
  const failure = (argv, result) => `\`${argv.join(' ')}\` failed${result.timedOut ? ' (timed out)' : ''}:\n${tail(result.stdout + result.stderr, 4000)}`;
  let evidence = [];

  // .NET: build each project once, one after another (they share dependencies, so parallel builds
  // would fight over obj/ folders), then run every project's tests at the same time with --no-build.
  // Functional test projects start their own containers, so they don't share state.
  const dotnet = (async () => {
    const out = [];
    const built = [];
    for (const project of projects) {
      const argv = expand(config.precheck.dotnetBuild, { project, story: story.key });
      log(`${story.key}: running ${argv.join(' ')}`);
      const result = run(argv[0], argv.slice(1), { cwd: config.root, timeoutSec: config.timeoutsSec.tests });
      if (result.status === 0) built.push(project);
      else out.push(failure(argv, result));
    }
    const results = await Promise.all(built.map((project) => {
      const argv = expand(dotnetTestCommand(config, project), { project, story: story.key });
      log(`${story.key}: running ${argv.join(' ')}`);
      return runAsync(argv[0], argv.slice(1), { cwd: config.root, timeoutSec: config.timeoutsSec.tests }).then((result) => ({ argv, result }));
    }));
    for (const { argv, result } of results) if (result.status !== 0) out.push(failure(argv, result));
    return out;
  })();

  // e2e: on a leased stack slot of its own when several tickets run at once (qe.useSlots, see
  // lib/slots.mjs), else the one shared slot-0 teststack per machine, where specs from different stories
  // (different worktrees) take turns. The lock lives in git's common dir, which every worktree shares.
  // Runs alongside .NET.
  const e2e = (async () => {
    if (!specFiles.length) return [];
    const argv = expand(config.precheck.playwright, { files: specFiles, casePrefix: casePrefix(story.key), story: story.key });
    const runSpecs = async (slotEnv) => {
      log(`${story.key}: running ${argv.join(' ')}${slotEnv.TESTSTACK_SLOT ? ` on slot ${slotEnv.TESTSTACK_SLOT}` : ''}`);
      const since = nowIso();
      // The verifier needs keyframes from passing tests too, so keep them for every e2e run.
      const result = await runAsync(argv[0], argv.slice(1), { cwd: config.root, timeoutSec: config.timeoutsSec.tests, env: { ...process.env, E2E_KEEP_VIDEOS: '1', ...slotEnv } });
      evidence = readEvidence(config, { casePrefix: casePrefix(story.key), since });
      if (result.status === 0) return [];
      let error = failure(argv, result);
      const failed = evidence.filter((t) => !t.ok);
      if (failed.length) {
        error += '\n\nWhat the browser showed (from the recorded run). Open the keyframes with your image/file read tool, '
          + 'starting with the `failure` and `step failed` frames, before you change any code:\n\n' + formatEvidence(failed);
      }
      return [error];
    };
    const onSlot = await onLeasedSlot(config, { key: story.key, specFiles, timeoutSec: config.timeoutsSec.tests }, runSpecs);
    if (onSlot) return onSlot;
    const lock = teststackLock(config);
    const deadline = Date.now() + config.timeoutsSec.tests * 1000 * 2;
    while (!acquireLock(lock)) {
      if (Date.now() > deadline) return [`Timed out waiting for the shared teststack (held by pid ${lockHolder(lock)}).`];
      log(`${story.key}: waiting for the teststack (pid ${lockHolder(lock)} is running e2e tests)`);
      await sleep(10_000);
    }
    try {
      return await runSpecs({});
    } finally {
      releaseLock(lock);
    }
  })();

  for (const list of await Promise.all([e2e, dotnet])) errors.push(...list);
  return { errors, tests, evidence };
}

// .NET test projects here use two frameworks: xUnit v3 (functional tests) and MSTest.Sdk (unit
// tests). They tag and filter differently, so each project gets its own story tag and test command.
const projectOf = (file) => file.split('/').slice(0, 2).join('/');

export function testFramework(config, project) {
  const dir = path.join(config.root, project);
  const csproj = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.csproj')) : null;
  const text = csproj ? fs.readFileSync(path.join(dir, csproj), 'utf8') : '';
  return /MSTest/i.test(text) ? 'mstest' : 'xunit';
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const storyTag = (framework, key) => framework === 'mstest'
  ? new RegExp(`TestCategory\\(\\s*"${escapeRe(key)}"\\s*\\)`)
  : new RegExp(`Trait\\(\\s*"Story"\\s*,\\s*"${escapeRe(key)}"\\s*\\)`);
const storyTagText = (framework, key) => (framework === 'mstest' ? `[TestCategory("${key}")]` : `[Trait("Story", "${key}")]`);

// precheck.dotnet is either one command for every project or one per framework ({ xunit, mstest }).
function dotnetTestCommand(config, project) {
  const cmd = config.precheck.dotnet;
  return Array.isArray(cmd) ? cmd : cmd[testFramework(config, project)] ?? cmd.xunit;
}

// Shared by every worktree of this repository (the main checkout and .claude/worktrees/*).
function teststackLock(config) {
  const common = git(config.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim() || path.join(config.root, '.git');
  return path.join(common, 'pipeline-locks', 'teststack.lock');
}

function automationTask(config, story, { mode, feedback, implFiles }) {
  const plan = readPlan(config, story);
  const lines = [
    `Story: ${story.key} (${story.file})`,
    `Mode: ${mode}`,
    `Verified plan: ${story.planDir} (${plan.cases.length} cases: ${plan.cases.map((c) => c.data.id).join(', ')})`,
    `Scenario directory: ${config.scenariosDir}/${story.scenario} (name: ${story.scenario})`,
    `Every test name must contain its case id. .NET tests also need the story tag and case id: in xUnit projects (functional tests) [Trait("Story", "${story.key}")] and [Trait("TestCase", "<id>")]; in MSTest projects (unit tests, MSTest.Sdk) [TestCategory("${story.key}")] and [TestProperty("TestCase", "<id>")].`,
    'Playwright specs under e2e/teststack/ build every URL from e2e/teststack/ports.ts (WEBAPP_URL, IDENTITY_URL, CATALOG_URL, port(name)); never hard-code 18xxx ports, so the specs run on whichever stack slot the run leased.',
    '',
    '### Implementation files changed for this story',
    '',
    implFiles.length ? implFiles.map((f) => `- ${f}`).join('\n') : '- (none detected; read the code the plan exercises)',
  ];
  if (mode === 'update') {
    lines.push('', 'Tests for this story already exist. Update them in place so they match the current plan and implementation; do not duplicate tests.');
  }
  if (feedback) lines.push('', '### Fix every item from the previous round', '', feedback);
  return lines.join('\n');
}

function automationVerifierTask(config, story, tests, evidence = []) {
  const plan = readPlan(config, story);
  const { scenario } = automationFiles(config, story);
  const lines = [
    `Story: ${story.key}`,
    `Required score: ${config.loops.requiredScore}/10`,
    `Allowed categories: ${config.categories.automation.join(', ')}`,
    'Set "root_stage": "plan" on a gap only when the test case itself is wrong or untestable, not the test.',
    '',
    '### Test cases (the specification the tests must match)',
  ];
  for (const c of plan.cases) lines.push('', `#### ${c.file}`, '', fence(c.text, 'markdown'));
  lines.push('', '### Automated tests');
  for (const [file, ids] of tests) lines.push('', `#### ${file} (references ${[...ids].join(', ')})`, '', fence(readRel(config, file), langFor(file)));
  lines.push('', `### Scenario data (${config.scenariosDir}/${story.scenario})`);
  for (const file of scenario) lines.push('', `#### ${file}`, '', fence(readRel(config, file), langFor(file)));
  lines.push('', 'Helper modules imported by the tests may be opened with your read tools if you need them.');
  if (evidence.some((t) => t.keyframes.length)) {
    lines.push(
      '',
      '### Visual evidence (keyframes from the recorded run of these tests)',
      '',
      'Open the keyframes with your image/file read tool and check, case by case, that the screen shows what the case expects '
        + 'at that point (right page, user, data and outcome; no error page or empty state where content is expected). '
        + 'A test that passes while the screen contradicts its case is a `visual-mismatch` gap.',
      '',
      formatEvidence(evidence),
    );
  }
  return lines.join('\n');
}

export const planVerifierTaskFor = (config, story) => planVerifierTask(config, story, readPlan(config, story));
export const automationVerifierTaskFor = (config, story) => automationVerifierTask(config, story, automationFiles(config, story).tests);

export async function automationLoop(config, story, { implHash = null, skipTests = false, resume = false, maxRounds = config.loops.automationMaxRounds } = {}) {
  const lock = lockFile(config, story.key, 'automation');
  if (!acquireLock(lock)) {
    updateState(config, story.key, (s) => (s.automation.requestedHash = implHash ?? s.automation.requestedHash));
    log(`${story.key}: automation already running (pid ${lockHolder(lock)}); queued a follow-up for the latest changes.`);
    return { status: 'busy' };
  }
  try {
    let targetHash = implHash ?? implChanges(config).hash;
    for (;;) {
      const saved = resume ? loadState(config, story.key).automation.progress : null;
      updateState(config, story.key, (s) => Object.assign(s.automation, { status: 'running', ...selfProcess(), requestedHash: null, workingHash: targetHash, startedAt: nowIso(), bugs: [] }));
      const result = await automationPass(config, story, { skipTests, maxRounds, targetHash, resume, saved: saved?.hash === targetHash ? saved : null });
      resume = false;
      const state = updateState(config, story.key, (s) => {
        Object.assign(s.automation, { status: result.status, pid: null, boot: null, ...RECOVERY_DONE, finishedAt: nowIso() });
        if (result.status === 'verified') s.automation.verifiedHash = targetHash;
        if (result.bugs) s.automation.bugs = result.bugs;
      });
      const next = state.automation.requestedHash;
      if (!next || next === targetHash || result.status === 'product-bug') return result;
      log(`${story.key}: implementation changed while tests were being written; updating tests.`);
      targetHash = next;
    }
  } finally {
    releaseLock(lock);
  }
}

async function automationPass(config, story, { skipTests, maxRounds, targetHash, resume = false, saved = null }) {
  const status = planStatus(config, story);
  if (status.state !== 'verified') {
    log(`${story.key}: plan is ${status.state}; running the plan loop first.`);
    let plan = await planLoop(config, story, { resume });
    // A plan run already in progress (for example the post-commit hook after the story's notes were
    // committed) holds the lock: wait for it, then use its plan (or run the loop if it didn't verify).
    const lock = lockFile(config, story.key, 'plan');
    const deadline = Date.now() + config.timeoutsSec.plan * 1000 * (config.loops.planMaxRounds + 1);
    while (plan.status === 'busy' && Date.now() < deadline) {
      log(`${story.key}: waiting for the running plan loop (pid ${lockHolder(lock)}).`);
      while (lockHolder(lock) && Date.now() < deadline) await sleep(5000);
      plan = planStatus(config, story).state === 'verified' ? { status: 'verified' } : await planLoop(config, story);
    }
    if (plan.status !== 'verified') return { status: 'blocked-on-plan' };
  }
  const implFiles = implChanges(config).files;
  let feedback = resume ? resumeFeedback('automation', saved?.feedback) : null;
  let lastGaps = [];
  for (let round = Math.min(saved?.round ?? 1, maxRounds); round <= maxRounds; round++) {
    updateState(config, story.key, (s) => (s.automation.progress = { hash: targetHash, round, feedback }));
    const mode = automationFiles(config, story).tests.size ? 'update' : 'create';
    log(`${story.key}: automation round ${round}/${maxRounds} (${mode})`);
    const producer = runAgent(config, {
      name: PRODUCER.automation,
      mode: 'write',
      model: config.agent.models.automation,
      timeoutSec: config.timeoutsSec.automation,
      usage: { stage: 'automation', story: story.key, round },
      task: automationTask(config, story, { mode, feedback, implFiles }),
    });
    const reported = extractResult(producer.output);
    if (reported?.status === 'product-bug') {
      const bugs = Array.isArray(reported.bugs) ? reported.bugs : [];
      logDecision(config, {
        stage: 'automation',
        story: story.key,
        round,
        agent: PRODUCER.automation,
        agentVer: producer.version,
        subject: 'implementer',
        decision: 'product-bug',
        reason: reported.summary ?? `${bugs.length} implementation bug(s)`,
        items: normalizeBugs(bugs),
      });
      escalate(config, story, 'automation', 'tests found implementation bugs', formatBugs(bugs));
      return { status: 'product-bug', bugs };
    }
    if (!producer.ok) {
      feedback = `The previous run ${producer.timedOut ? 'timed out' : `failed (exit ${producer.status})`}. Finish the tests.`;
      continue;
    }
    const pre = await precheckAutomation(config, story, { skipTests });
    if (pre.errors.length) {
      logPrecheck(config, 'automation', story, round, pre.errors);
      feedback = `Deterministic checks failed:\n${pre.errors.map((e) => `- ${e}`).join('\n')}`;
      continue;
    }
    let verdict;
    let consecutive = 0;
    do {
      verdict = runVerifier(config, { stage: 'automation', story, round, producerVersion: producer.version, task: automationVerifierTask(config, story, pre.tests, pre.evidence) });
      if (verdict.error) break;
      consecutive = verdict.passed ? consecutive + 1 : 0;
    } while (verdict.passed && consecutive < config.loops.consecutivePasses);
    if (verdict.error) continue;
    if (verdict.passed) {
      stampIndex(config, story, {
        'automation-sha': automationSha(config, story),
        'automation-plan-sha': readPlan(config, story).index.data['plan-sha'],
        'automation-score': verdict.score,
        'automation-verified-at': nowIso(),
      });
      clearEscalation(config, story, 'automation');
      log(`${story.key}: automated tests verified ${verdict.score}/10 after ${round} round(s).`);
      return { status: 'verified', rounds: round };
    }
    lastGaps = verdict.gaps;
    const planGaps = verdict.gaps.filter((g) => g.root_stage === 'plan');
    if (planGaps.length) {
      log(`${story.key}: ${planGaps.length} gap(s) trace back to the plan; sending them to the plan agent.`);
      const plan = await planLoop(config, story, { seedFeedback: `The automation verifier traced these problems to the test cases themselves:\n${formatGaps(planGaps)}` });
      if (plan.status !== 'verified') return { status: 'blocked-on-plan' };
    }
    feedback = `The verifier scored the tests ${verdict.score}/10. Fix every gap:\n${formatGaps(verdict.gaps.filter((g) => g.root_stage !== 'plan'))}${planGaps.length ? '\n\nThe plan was also updated to fix case-level problems; re-read the case files.' : ''}`;
  }
  escalate(config, story, 'automation', `tests did not reach ${config.loops.requiredScore}/10 in ${maxRounds} rounds`, lastGaps.length ? formatGaps(lastGaps) : feedback ?? '');
  return { status: 'escalated' };
}

// ---------------------------------------------------------------------------------------------
// Background runs
// ---------------------------------------------------------------------------------------------

export const spawnQe = (config, key, stage, args, file) => spawnBackground(config, { script: QE_SCRIPT, key, stage, args, file });

export function startAutomation(config, story, implHash) {
  const holder = lockHolder(lockFile(config, story.key, 'automation'));
  if (holder) {
    updateState(config, story.key, (s) => (s.automation.requestedHash = implHash));
    return { queued: true, pid: holder };
  }
  // Saved before spawning: the child updates the same state file (and records its own pid), so a
  // write after the spawn could race it and drop the log path or reset the status.
  const file = logFile(config, story.key, 'automation');
  const log = path.relative(config.root, file);
  updateState(config, story.key, (s) => Object.assign(s.automation, { status: 'starting', pid: null, boot: null, log, requestedHash: null, workingHash: implHash, requestedAt: nowIso(), ...RECOVERY_DONE }));
  return spawnQe(config, story.key, 'automation', ['automate', story.key, '--impl-hash', implHash], file);
}

// ---------------------------------------------------------------------------------------------
// Crash recovery: background plan and automation runs that died (crash, kill, reboot) are resumed
// from their last round, retried a few times with growing delays, then escalated.
// ---------------------------------------------------------------------------------------------

export const RUN_KINDS = ['plan', 'automation'];

function resumeFeedback(kind, feedback) {
  const note = `A previous ${kind === 'plan' ? 'plan' : 'test automation'} run was interrupted before it finished. Keep the work already on disk and complete it.`;
  return feedback ? `${note}\n\n${feedback}` : note;
}

// The run recorded itself as active but its process is gone ("queued" covers the rest of a plan batch).
export const isInterrupted = (config, story, kind, state = loadState(config, story.key)) =>
  runDied(config, state[kind], { active: ['running', 'queued', 'starting'], lock: lockFile(config, story.key, kind) });

// Resumes one interrupted run in the background. `force` also restarts a run that used up its
// attempts ("crashed") and ignores the backoff. Returns what happened, or null if nothing needed doing.
export function recoverRun(config, story, kind, { force = false } = {}) {
  const state = loadState(config, story.key);
  const s = state[kind];
  if (!isInterrupted(config, story, kind, state) && !(force && s.status === 'crashed')) return null;
  const set = (fields) => updateState(config, story.key, (st) => Object.assign(st[kind], fields));

  let hash = null;
  if (kind === 'automation') {
    hash = s.workingHash ?? null;
    if (!hash || hash !== implChanges(config).hash) {
      set({ status: 'interrupted', pid: null, boot: null, progress: null });
      return { kind, action: 'abandoned', reason: 'the implementation changed since it started' };
    }
  }
  const next = nextAttempt(config, s, { force });
  if (next.action === 'waiting') return { kind, ...next };
  if (next.action === 'crashed') {
    set({ status: 'crashed', pid: null, boot: null });
    escalate(config, story, kind, `${kind} run crashed ${next.attempts + 1} times`, `Last log: ${s.log ?? 'none'}\n\nAfter fixing the cause, resume it with \`node scripts/pipeline/pipeline.mjs resume ${story.key} --force\`.`);
    return { kind, ...next };
  }
  const file = logFile(config, story.key, kind);
  const rel = path.relative(config.root, file);
  set({ status: 'starting', pid: null, boot: null, log: rel, requestedAt: nowIso(), ...next.fields });
  const args = kind === 'automation' ? ['automate', story.key, '--impl-hash', hash, '--resume'] : ['plan', story.key, '--resume'];
  spawnQe(config, story.key, kind, args, file);
  log(`${story.key}: resumed the interrupted ${kind} run (attempt ${next.attempt}/${next.maxAttempts}, log ${rel}).`);
  return { kind, action: 'resumed', attempt: next.attempt, round: s.progress?.round ?? 1, log: rel };
}

// Every story with an interrupted run, or only `keys`. Stories missing from this checkout are skipped.
export function recoverAll(config, stories, { keys = null, force = false } = {}) {
  const results = [];
  for (const story of stories) {
    if (keys && !keys.includes(story.key)) continue;
    for (const kind of RUN_KINDS) {
      const r = recoverRun(config, story, kind, { force });
      if (r) results.push({ story: story.key, ...r });
    }
  }
  return results;
}

export function formatRecovery(r) {
  const what = r.kind === 'plan' ? 'test plan' : 'test automation';
  if (r.action === 'resumed') return `QE: resumed the interrupted ${what} run for ${r.story} at round ${r.round} (attempt ${r.attempt}, log: ${r.log}).`;
  if (r.action === 'waiting') return `QE: the ${what} run for ${r.story} crashed; it is retried after ${r.retryAt}.`;
  if (r.action === 'crashed') return `QE: the ${what} run for ${r.story} kept crashing and was escalated (.agent-state/escalations/${r.story}-${r.kind}.md).`;
  return `QE: dropped the interrupted ${what} run for ${r.story}: ${r.reason}.`;
}

// ---------------------------------------------------------------------------------------------
// Agent lifecycle hook: implementation agent Stop / SubagentStop
// ---------------------------------------------------------------------------------------------

// Automation already runs, or already ran on this implementation, and needs no restart. A run that stopped
// on the plan (`blocked-on-plan`) does need one once the plan is verified (a `qe plan` re-run after the
// escalation was handled): with the implementation unchanged, nothing else would ever start it again.
export const automationUpToDate = (automation, hash, planState = null) =>
  ['running', 'starting'].includes(automation.status) ||
  (automation.workingHash === hash && automation.status !== 'interrupted' && !(automation.status === 'blocked-on-plan' && planState === 'verified'));

// Runs after the review stage in the dispatcher. Its gate is the review's approval of the exact
// implementation now on disk; automation then runs in the background so the agent can finish.
export function hookStop(config, story) {
  const state = loadState(config, story.key);
  if (!state.done) return null;
  const { hash } = implChanges(config);
  if (!hash || state.review.lastVerdict !== 'APPROVED' || state.review.approvedHash !== hash) return null;
  const automation = state.automation;
  if (automation.verifiedHash === hash) return null;
  if (isInterrupted(config, story, 'automation', state)) {
    const recovered = recoverRun(config, story, 'automation');
    if (recovered && recovered.action !== 'abandoned') return { systemMessage: formatRecovery({ story: story.key, ...recovered }) };
  } else if (automationUpToDate(automation, hash, automation.status === 'blocked-on-plan' ? planStatus(config, story).state : null)) {
    return null;
  }
  const bg = startAutomation(config, story, hash);
  return { systemMessage: `QE: test automation for ${story.key} ${bg.queued ? 'queued behind the running job' : `started in the background (log: ${bg.log})`}.` };
}

// Context injected at session start so agents see QE state without asking.
// Only the active story: agents are not told about other stories (story guard).
export function sessionContext(config, story, recovered = []) {
  const lines = [];
  if (story) {
    for (const r of recovered.filter((r) => r.story === story.key)) lines.push(formatRecovery(r));
    const state = loadState(config, story.key);
    lines.push(`QE for ${story.key}: plan ${planStatus(config, story).state}, test automation ${state.automation.status}.`);
    if (state.automation.bugs?.length) lines.push(`QE found implementation bugs:\n${formatBugs(state.automation.bugs)}`);
  }
  return lines.join('\n');
}
