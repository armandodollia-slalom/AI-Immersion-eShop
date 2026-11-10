import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDefinition, runAgent } from '../../pipeline/lib/agents.mjs';
import { spawnBackground } from '../../pipeline/lib/background.mjs';
import { git, implChanges, implDiff } from '../../pipeline/lib/git.mjs';
import { readEvidence, formatEvidence } from './evidence.mjs';
import {
  INDEX,
  automationFiles,
  automationSha,
  planContentSha,
  planStatus,
  precheckPlan,
  readPlan,
  stampIndex,
} from './plans.mjs';
import { clearEscalation, escalate, lockFile, logFile, loadState, metricsFile, updateState } from '../../pipeline/lib/state.mjs';
import { casePrefix, storySha } from '../../pipeline/lib/stories.mjs';
import { acquireLock, appendJsonl, extractResult, lockHolder, log, nowIso, releaseLock, run, runAsync, sleep, tail } from '../../pipeline/lib/util.mjs';
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

// Finds the committed version of the story the plan was written against and diffs it with the
// current story, so an update can edit the affected cases in place instead of rewriting the plan.
export function storyDiffSince(config, story, oldSha) {
  if (!oldSha) return null;
  const revs = git(config.root, ['log', '--format=%H', '-n', '50', '--', story.file]).stdout.split('\n').filter(Boolean);
  for (const rev of revs) {
    const text = git(config.root, ['show', `${rev}:${story.file}`]);
    if (text.status === 0 && storySha(text.stdout) === oldSha) {
      return git(config.root, ['diff', '--no-ext-diff', rev, '--', story.file]).stdout || null;
    }
  }
  return null;
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

export async function planLoop(config, story, { force = false, seedFeedback = null, maxRounds = config.loops.planMaxRounds } = {}) {
  const lock = lockFile(config, story.key, 'plan');
  if (!acquireLock(lock)) {
    log(`${story.key}: plan run already in progress (pid ${lockHolder(lock)}).`);
    return { status: 'busy' };
  }
  try {
    const initial = planStatus(config, story);
    if (initial.state === 'verified' && !force && !seedFeedback) {
      log(`${story.key}: plan is verified and up to date.`);
      return { status: 'verified' };
    }
    updateState(config, story.key, (s) => Object.assign(s.plan, { status: 'running', pid: process.pid, startedAt: nowIso() }));
    const mode = initial.state === 'missing' ? 'create' : 'update';
    const storyDiff = mode === 'update' ? storyDiffSince(config, story, initial.plan.index?.data['story-sha']) : null;
    let feedback = seedFeedback;
    let consecutive = 0;
    let lastGaps = [];
    for (let round = 1; round <= maxRounds; round++) {
      log(`${story.key}: plan round ${round}/${maxRounds} (${mode})`);
      const producer = runAgent(config, {
        name: PRODUCER.plan,
        mode: 'write',
        model: config.agent.models.plan,
        timeoutSec: config.timeoutsSec.plan,
        task: planTask(config, story, { mode: round === 1 ? mode : 'update', reasons: initial.reasons, storyDiff, feedback }),
      });
      if (!producer.ok) {
        feedback = `The previous run ${producer.timedOut ? 'timed out' : `failed (exit ${producer.status})`}. Finish the plan.`;
        continue;
      }
      stampIndex(config, story, { 'plan-sha': undefined, 'verified-score': undefined, 'verified-at': undefined, 'verified-by': undefined });
      const pre = precheckPlan(config, story);
      if (pre.errors.length) {
        logPrecheck(config, 'plan', story, round, pre.errors);
        feedback = `Structural check failed:\n${pre.errors.map((e) => `- ${e}`).join('\n')}`;
        continue;
      }
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
        updateState(config, story.key, (s) => Object.assign(s.plan, { status: 'verified', pid: null, rounds: round, finishedAt: nowIso() }));
        log(`${story.key}: plan verified ${verdict.score}/10 after ${round} round(s).`);
        return { status: 'verified', rounds: round };
      }
      lastGaps = verdict.gaps;
      feedback = `The verifier scored the plan ${verdict.score}/10. Fix every gap:\n${formatGaps(verdict.gaps)}`;
    }
    escalate(config, story, 'plan', `plan did not reach ${config.loops.requiredScore}/10 in ${maxRounds} rounds`, lastGaps.length ? formatGaps(lastGaps) : feedback ?? '');
    updateState(config, story.key, (s) => Object.assign(s.plan, { status: 'escalated', pid: null, finishedAt: nowIso() }));
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

  // e2e: one shared teststack per machine, so specs from different stories (different worktrees)
  // take turns. The lock lives in git's common dir, which every worktree shares. Runs alongside .NET.
  const e2e = (async () => {
    if (!specFiles.length) return [];
    const argv = expand(config.precheck.playwright, { files: specFiles, casePrefix: casePrefix(story.key), story: story.key });
    const lock = teststackLock(config);
    const deadline = Date.now() + config.timeoutsSec.tests * 1000 * 2;
    while (!acquireLock(lock)) {
      if (Date.now() > deadline) return [`Timed out waiting for the shared teststack (held by pid ${lockHolder(lock)}).`];
      log(`${story.key}: waiting for the teststack (pid ${lockHolder(lock)} is running e2e tests)`);
      await sleep(10_000);
    }
    try {
      log(`${story.key}: running ${argv.join(' ')}`);
      const since = nowIso();
      // The verifier needs keyframes from passing tests too, so keep them for every e2e run.
      const result = await runAsync(argv[0], argv.slice(1), { cwd: config.root, timeoutSec: config.timeoutsSec.tests, env: { ...process.env, E2E_KEEP_VIDEOS: '1' } });
      evidence = readEvidence(config, { casePrefix: casePrefix(story.key), since });
      if (result.status === 0) return [];
      let error = failure(argv, result);
      const failed = evidence.filter((t) => !t.ok);
      if (failed.length) {
        error += '\n\nWhat the browser showed (from the recorded run). Open the keyframes with your image/file read tool, '
          + 'starting with the `failure` and `step failed` frames, before you change any code:\n\n' + formatEvidence(failed);
      }
      return [error];
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

export async function automationLoop(config, story, { implHash = null, skipTests = false, maxRounds = config.loops.automationMaxRounds } = {}) {
  const lock = lockFile(config, story.key, 'automation');
  if (!acquireLock(lock)) {
    updateState(config, story.key, (s) => (s.automation.requestedHash = implHash ?? s.automation.requestedHash));
    log(`${story.key}: automation already running (pid ${lockHolder(lock)}); queued a follow-up for the latest changes.`);
    return { status: 'busy' };
  }
  try {
    let targetHash = implHash ?? implChanges(config).hash;
    for (;;) {
      updateState(config, story.key, (s) => Object.assign(s.automation, { status: 'running', pid: process.pid, requestedHash: null, workingHash: targetHash, startedAt: nowIso(), bugs: [] }));
      const result = await automationPass(config, story, { skipTests, maxRounds });
      const state = updateState(config, story.key, (s) => {
        Object.assign(s.automation, { status: result.status, pid: null, finishedAt: nowIso() });
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

async function automationPass(config, story, { skipTests, maxRounds }) {
  const status = planStatus(config, story);
  if (status.state !== 'verified') {
    log(`${story.key}: plan is ${status.state}; running the plan loop first.`);
    let plan = await planLoop(config, story);
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
  let feedback = null;
  let lastGaps = [];
  for (let round = 1; round <= maxRounds; round++) {
    const mode = automationFiles(config, story).tests.size ? 'update' : 'create';
    log(`${story.key}: automation round ${round}/${maxRounds} (${mode})`);
    const producer = runAgent(config, {
      name: PRODUCER.automation,
      mode: 'write',
      model: config.agent.models.automation,
      timeoutSec: config.timeoutsSec.automation,
      task: automationTask(config, story, { mode, feedback, implFiles }),
    });
    const reported = extractResult(producer.output);
    if (reported?.status === 'product-bug') {
      const bugs = Array.isArray(reported.bugs) ? reported.bugs : [];
      escalate(config, story, 'automation', 'tests found implementation bugs', bugs.map((b) => `- ${typeof b === 'string' ? b : JSON.stringify(b)}`).join('\n'));
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
  updateState(config, story.key, (s) => Object.assign(s.automation, { status: 'starting', pid: null, log, requestedHash: null }));
  return spawnQe(config, story.key, 'automation', ['automate', story.key, '--impl-hash', implHash], file);
}

// ---------------------------------------------------------------------------------------------
// Agent lifecycle hook: implementation agent Stop / SubagentStop
// ---------------------------------------------------------------------------------------------

// Runs after the review stage in the dispatcher. Its gate is the review's approval of the exact
// implementation now on disk; automation then runs in the background so the agent can finish.
export function hookStop(config, story) {
  const state = loadState(config, story.key);
  if (!state.done) return null;
  const { hash } = implChanges(config);
  if (!hash || state.review.lastVerdict !== 'APPROVED' || state.review.approvedHash !== hash) return null;
  const automation = state.automation;
  if (automation.verifiedHash === hash || automation.workingHash === hash || ['running', 'starting'].includes(automation.status)) return null;
  const bg = startAutomation(config, story, hash);
  return { systemMessage: `QE: test automation for ${story.key} ${bg.queued ? 'queued behind the running job' : `started in the background (log: ${bg.log})`}.` };
}

// Context injected at session start so agents see QE state without asking.
// Only the active story: agents are not told about other stories (story guard).
export function sessionContext(config, story) {
  const lines = [];
  if (story) {
    const state = loadState(config, story.key);
    lines.push(`QE for ${story.key}: plan ${planStatus(config, story).state}, test automation ${state.automation.status}.`);
    if (state.automation.bugs?.length) lines.push(`QE found implementation bugs:\n${state.automation.bugs.map((b) => `- ${typeof b === 'string' ? b : JSON.stringify(b)}`).join('\n')}`);
  }
  return lines.join('\n');
}
