// End-to-end runs of the pipeline (dispatcher, review and QE stages) in a throwaway git repo, with a
// scripted fake agent CLI standing in for Claude/Copilot/Codex (PIPELINE_AGENT_CMD).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CACHE, seedTicket } from './fixtures/tickets.mjs';
import { fsReader } from '../lib/git.mjs';
import { planContentSha, readPlan } from '../../qe/lib/plans.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fakeAgent = path.join(here, 'fixtures', 'fake-agent.mjs');
const fakePolicy = path.join(here, 'fixtures', 'fake-policy.mjs');
let repo;
let scriptFile;

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
};
const gitc = (...args) => sh('git', args);
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const jsonl = (name) => {
  const file = path.join(repo, '.agent-metrics', name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const stateOf = (key) => JSON.parse(read(`.agent-state/stories/${key}.json`));

function agentScript(script) {
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
}
const calls = () => (fs.existsSync(`${scriptFile}.calls.json`) ? JSON.parse(fs.readFileSync(`${scriptFile}.calls.json`, 'utf8')) : {});
const prompts = () => fs.readFileSync(`${scriptFile}.prompts.log`, 'utf8');

function cli(script, args, { input = '', env = {} } = {}) {
  const base = { ...process.env };
  delete base.PIPELINE_CHILD;
  delete base.PIPELINE_DISABLE;
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    input,
    encoding: 'utf8',
    env: { ...base, PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', ...env },
  });
}
const qe = (args, opts) => cli('scripts/qe/qe.mjs', args, opts);
const pipeline = (args, opts) => cli('scripts/pipeline/pipeline.mjs', args, opts);

async function waitFor(predicate, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for background run');
}

// The story is a board ticket: its cached copy, as `board fetch` writes it (no GitHub in these tests).
const STORY = `${CACHE}/DEMO-1/story.md`;
const STORY_TEXT = '# DEMO-1 Apply coupon\n\nRule: a valid coupon gives 10% off; an expired coupon is rejected with 400.\n';
const PLAN = 'tests/plans/DEMO-1-apply-coupon';
const happySad = [{ title: 'Valid coupon applies', type: 'happy' }, { title: 'Expired coupon rejected', type: 'sad' }];

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-e2e-'));
  scriptFile = path.join(repo, '..', `${path.basename(repo)}-agent.json`);
  for (const dir of ['scripts/pipeline', 'scripts/review', 'scripts/qe', 'scripts/implement', 'scripts/pr-check', 'scripts/board', 'scripts/models', 'scripts/pr-video']) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  fs.cpSync(path.join(source, '.github/agents'), path.join(repo, '.github/agents'), { recursive: true });
  const config = JSON.parse(read('scripts/qe/config.json'));
  config.precheck.runTests = false;
  write('scripts/qe/config.json', JSON.stringify(config, null, 2));
  // The PR check's own hook flow is covered in scripts/pr-check/test.
  const prCheckConfig = JSON.parse(read('scripts/pr-check/config.json'));
  prCheckConfig.prCheck.hook.enabled = false;
  write('scripts/pr-check/config.json', JSON.stringify(prCheckConfig, null, 2));
  write('.gitignore', '.agent-state/\n');
  seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-apply-coupon', text: STORY_TEXT });
  write('src/Basket/Coupons.cs', '// coupons\n');
  gitc('init', '-q', '-b', 'main');
  gitc('config', 'user.email', 'qe@example.com');
  gitc('config', 'user.name', 'QE Test');
  gitc('add', '-A');
  gitc('commit', '-qm', 'init');
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  for (const suffix of ['', '.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
});

test('workflow 1: plan loops with a fresh verifier until 10/10, logs denials, and goes stale when the story changes', () => {
  agentScript({
    'qe-plan': [{ writePlan: [happySad[0]] }, { writePlan: happySad.map((c, i) => ({ ...c, why: `protects rule ${i}` })), result: { status: 'done', cases: 2, summary: 'one case per outcome', excluded: [{ item: 'rate limits', why: 'out of scope' }] } }],
    'qe-plan-verifier': [
      { result: { score: 7, summary: 'no auth case', gaps: [{ case: null, category: 'missing-sad-path', subtype: 'auth', detail: 'no unauthenticated case' }] } },
      { result: { score: 10, summary: 'complete', gaps: [] } },
    ],
  });
  const result = qe(['plan', 'DEMO-1']);
  assert.equal(result.status, 0, result.stderr);

  // Round 1: deterministic precheck (no sad case) fails before any verifier call.
  // Round 2: verifier denies 7/10. Round 3: verifier passes 10/10.
  assert.deepEqual(calls(), { 'qe-plan': 3, 'qe-plan-verifier': 2 });
  assert.match(jsonl('precheck-failures.jsonl')[0].errors.join('\n'), /no sad-path case/);
  const denials = jsonl('verifier-denials.jsonl');
  assert.equal(denials.length, 1);
  assert.deepEqual([denials[0].category, denials[0].subtype, denials[0].attributed_agent, denials[0].round], ['missing-sad-path', 'auth', 'qe-plan', 2]);
  assert.deepEqual(jsonl('verifier-runs.jsonl').map((r) => [r.score, r.passed]), [[7, false], [10, true]]);
  assert.match(prompts(), /Fix every gap:\n1\. \[missing-sad-path\/auth\] \(plan-wide\): no unauthenticated case/);
  // Decision log: why the plan has these cases (each round past the precheck), and why the verifier ruled as it did.
  const decisions = jsonl('decisions.jsonl');
  assert.deepEqual(decisions.map((d) => [d.stage, d.round, d.decision]), [['plan', 2, 'plan-written'], ['plan-verify', 2, 'denied'], ['plan', 3, 'plan-written'], ['plan-verify', 3, 'approved']]);
  assert.deepEqual([decisions[0].reason, decisions[0].excluded], ['one case per outcome', [{ item: 'rate limits', reason: 'out of scope' }]]);
  assert.deepEqual(decisions[0].items.map((i) => [i.case, i.type, i.reason]), [['TC-DEMO-1-01', 'happy', 'protects rule 0'], ['TC-DEMO-1-02', 'sad', 'protects rule 1']]);
  assert.deepEqual([decisions[1].agent, decisions[1].subject, decisions[1].reason, decisions[1].score], ['qe-plan-verifier', 'qe-plan', 'no auth case', 7]);
  assert.deepEqual(decisions[1].items, [{ case: null, category: 'missing-sad-path', subtype: 'auth', location: null, root_stage: 'plan', reason: 'no unauthenticated case', subject: 'qe-plan' }]);
  // Every agent call is a separate child process flagged so hooks inside it stay quiet.
  assert.doesNotMatch(prompts(), /child=undefined/);

  const index = read(`${PLAN}/_index.md`);
  assert.match(index, /verified-score: 10/);
  assert.match(qe(['check', '--all']).stdout, /ok +DEMO-1 +plan=verified/);

  gitc('add', '-A');
  gitc('commit', '-qm', 'plan');
  gitc('checkout', '-qb', 'feature/DEMO-1');
  // The issue changed and was fetched again; the push carries only code, and is found through its branch.
  seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-apply-coupon', text: `${read(STORY)}\nRule: coupons cannot be combined (409).\n` });
  write('src/Basket/Coupons.cs', '// coupons v2\n');
  gitc('commit', '-qam', 'code change');

  const check = qe(['check', '--changed-from', 'main']);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /FAIL DEMO-1 +plan=stale/);
  const prePush = pipeline(['git-hook', 'pre-push'], { input: `refs/heads/feature/DEMO-1 ${gitc('rev-parse', 'HEAD').stdout.trim()} refs/heads/feature/DEMO-1 0000000000000000000000000000000000000000\n` });
  assert.equal(prePush.status, 1);
  assert.equal(pipeline(['git-hook', 'pre-push'], { input: 'x', env: { QE_SKIP: '1' } }).status, 0);

  // Update in place: the agent gets the story diff.
  agentScript({ 'qe-plan': [{ writePlan: [...happySad, { title: 'Combined coupons rejected', type: 'sad' }] }], 'qe-plan-verifier': [{ result: { score: 10, gaps: [] } }] });
  assert.equal(qe(['plan', '--stale']).status, 0);
  assert.match(prompts(), /Mode: update \(story changed since the plan was written\)/);
  assert.match(prompts(), /\+Rule: coupons cannot be combined \(409\)\./);
  gitc('add', '-A');
  gitc('commit', '-qm', 'replan');
  assert.equal(qe(['check', '--changed-from', 'main']).status, 0);
});

test('workflow 2: the dispatcher runs the review stage first, then automation loops to 10/10 and routes plan-level gaps back to the plan agent', async () => {
  const blocking = { verdict: 'CHANGES_REQUESTED', summary: 'bypasses ownership check', findings: [{ severity: 'blocking', category: 'security', file: 'src/Basket/Coupons.cs', line: 1, issue: 'no owner check', fix: 'check buyer id' }] };
  agentScript({
    'architecture-reviewer': [{ result: blocking }, { result: { verdict: 'APPROVED', summary: 'ok', findings: [] } }],
    'qe-automation': [{ writeTests: [1], result: { status: 'done' } }, { writeTests: [1, 2, 3], result: { status: 'done' } }],
    'qe-automation-verifier': [
      { result: { score: 6, gaps: [{ case: 'TC-DEMO-1-02', category: 'missing-assertion', detail: 'status only', location: 'e2e/teststack/demo-1.spec.ts:2' }, { case: 'TC-DEMO-1-03', category: 'tests-different-path', root_stage: 'plan', detail: 'case does not say which coupons' }] } },
      { result: { score: 10, gaps: [] } },
    ],
    'qe-plan': [{ writePlan: [...happySad, { title: 'Combined coupons rejected', type: 'sad', expected: '409 with code COUPON_COMBINE' }] }],
    'qe-plan-verifier': [{ result: { score: 10, gaps: [] } }],
  });
  const stop = (payload = {}, env) => {
    const r = pipeline(['hook', 'stop'], { input: JSON.stringify(payload), env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };

  const start = pipeline(['start', 'DEMO-1']);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /Active story: DEMO-1\. Story: \.agent-state\/board\/DEMO-1\/story\.md\.\nTest plan for DEMO-1: verified/, 'stages report on story-start');
  const context = JSON.parse(pipeline(['hook', 'session-start']).stdout);
  assert.match(context.additionalContext, /active story DEMO-1[\s\S]*Architecture review for DEMO-1: not run[\s\S]*QE for DEMO-1: plan verified/, 'Copilot reads only the top-level key; every stage contributes');
  assert.equal(context.hookSpecificOutput.additionalContext, context.additionalContext);
  assert.deepEqual(Object.keys(JSON.parse(pipeline(['hook', 'session-start', '--nested']).stdout)), ['hookSpecificOutput'], 'Codex rejects unknown keys');
  write('src/Basket/Coupons.cs', '// coupons v2\n');
  assert.equal(stop(), null, 'no review until the agent declares the work done');
  assert.equal(stop({}, { PIPELINE_CHILD: '1' }), null);
  assert.equal(pipeline(['done']).status, 0);
  assert.equal(stop({}, { PIPELINE_CHILD: '1' }), null, 'pipeline child agents never trigger the hook');

  const first = stop();
  assert.equal(first.decision, 'block');
  assert.equal(stateOf('DEMO-1').automation.status, 'idle', 'a blocking review stops the dispatcher before the QE stage');
  assert.match(first.reason, /round 1\/5 .*requested changes[\s\S]*no owner check[\s\S]*Fix: check buyer id/);
  assert.equal(stop().decision, 'block', 'blocks once more if nothing changed');
  assert.match(stop().systemMessage, /still has unresolved architecture findings/);
  assert.equal(calls()['architecture-reviewer'], 1, 'cached verdict, no re-review for the same code');

  write('src/Basket/Coupons.cs', '// coupons v3 with owner check\n');
  const approved = stop({ stop_hook_active: true });
  assert.match(approved.systemMessage, /approved DEMO-1 \(round 2\)\.\nQE: test automation for DEMO-1 started in the background/);
  await waitFor(() => !['starting', 'running'].includes(stateOf('DEMO-1').automation.status));

  const state = stateOf('DEMO-1');
  assert.ok(state.automation.log, 'automation log path is recorded');
  assert.equal(state.automation.status, 'verified', read(state.automation.log));
  assert.deepEqual(calls(), { 'architecture-reviewer': 2, 'qe-automation': 3, 'qe-automation-verifier': 2, 'qe-plan': 1, 'qe-plan-verifier': 1 });
  assert.match(jsonl('precheck-failures.jsonl').at(-1).errors.join('\n'), /TC-DEMO-1-02 has no automated test/);

  const autoDenials = jsonl('verifier-denials.jsonl').filter((d) => d.stage === 'automation');
  assert.deepEqual(autoDenials.map((d) => [d.case, d.attributed_agent, d.root_stage]), [
    ['TC-DEMO-1-02', 'qe-automation', 'automation'],
    ['TC-DEMO-1-03', 'qe-plan', 'plan'],
  ]);
  assert.match(prompts(), /traced these problems to the test cases themselves:\n1\. \[tests-different-path\] TC-DEMO-1-03/);
  assert.deepEqual(jsonl('arch-reviews.jsonl').map((r) => r.verdict), ['CHANGES_REQUESTED', 'APPROVED']);
  const reviews = jsonl('decisions.jsonl').filter((d) => d.stage === 'review');
  assert.deepEqual(reviews.map((d) => [d.agent, d.subject, d.decision, d.reason]), [['architecture-reviewer', 'implementer', 'changes-requested', 'bypasses ownership check'], ['architecture-reviewer', 'implementer', 'approved', 'ok']]);
  assert.deepEqual([reviews[0].items[0].reason, reviews[0].items[0].fix], ['no owner check', 'check buyer id']);
  const autoVerify = jsonl('decisions.jsonl').filter((d) => d.stage === 'automation-verify');
  assert.deepEqual(autoVerify.map((d) => d.decision), ['denied', 'approved']);
  assert.deepEqual(autoVerify[0].items.map((i) => [i.case, i.subject]), [['TC-DEMO-1-02', 'qe-automation'], ['TC-DEMO-1-03', 'qe-plan']]);

  assert.match(read(`${PLAN}/_index.md`), /automation-score: 10/);
  assert.match(pipeline(['status', 'DEMO-1']).stdout, /\[review\]\nDEMO-1 +review=APPROVED[\s\S]*\[qe\]\nDEMO-1 +plan=verified .*tests=1 +automation=verified\/verified/);
  assert.equal(stop(), null, 'approved and verified: nothing left to do');

  // A plan and tests verified with compact table delimiter rows (markdownlint MD060) are tidied and stay verified.
  write(`${PLAN}/_index.md`, `${read(`${PLAN}/_index.md`).trimEnd()}\n\n| ID | Title |\n|----|:------|\n| TC-DEMO-1-01 | Valid coupon applies |\n`);
  const compactSha = planContentSha(readPlan({}, { planDir: PLAN }, fsReader(repo)));
  write(`${PLAN}/_index.md`, read(`${PLAN}/_index.md`).replace(/^(plan-sha|automation-plan-sha): .*$/gm, `$1: ${compactSha}`));
  const verifiedStatus = /DEMO-1 +plan=verified .*automation=verified\/verified/;
  assert.match(qe(['status', 'DEMO-1']).stdout, verifiedStatus);
  assert.match(qe(['tidy', 'DEMO-1']).stdout, /DEMO-1: plan markdown tidied/);
  assert.match(read(`${PLAN}/_index.md`), /^\| ---- \| :------ \|$/m);
  assert.match(qe(['status', 'DEMO-1']).stdout, verifiedStatus);

  // Editing a verified test invalidates the stamp so CI and pre-push catch it.
  write('e2e/teststack/demo-1.spec.ts', `${read('e2e/teststack/demo-1.spec.ts')}// tweak\n`);
  assert.match(qe(['check', '--all']).stdout, /FAIL DEMO-1 .*tests or scenario edited after verification/);

  const metrics = JSON.parse(pipeline(['metrics', '--json']).stdout);
  assert.equal(metrics.qe.crossStage.automationDenialsCausedByPlan, 1);
  assert.equal(metrics.qe.stages.automation.verifierRounds, 2);
  assert.deepEqual([metrics.review.rounds, metrics.review.approvals, metrics.review.findingsByCategory.security], [2, 1, 1]);
});

test('a crashed automation run resumes from its last round, is retried, then escalated, and --force restarts it', async () => {
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // The runner sits on the killed state with its recorded process gone.
  const crashed = () => waitFor(() => stateOf('DEMO-1').automation.status === 'running' && !alive(stateOf('DEMO-1').automation.pid));
  const stop = () => {
    const r = pipeline(['hook', 'stop'], { input: '{}' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const pipelineConfig = read('scripts/pipeline/config.json');
  const config = JSON.parse(pipelineConfig);
  config.recovery = { maxAttempts: 1, backoffSec: 0, startingGraceSec: 120 };
  write('scripts/pipeline/config.json', JSON.stringify(config, null, 2));
  try {
    agentScript({
      'architecture-reviewer': [{ result: { verdict: 'APPROVED', summary: 'ok', findings: [] } }],
      // Round 1 leaves two cases untested (precheck fails); the runner dies in round 2.
      'qe-automation': [{ writeTests: [1], result: { status: 'done' } }, { killRunner: 'automation' }, { writeTests: [1, 2, 3], result: { status: 'done' } }],
      'qe-automation-verifier': [{ result: { score: 10, gaps: [] } }],
    });
    assert.equal(pipeline(['start', 'DEMO-1']).status, 0);
    assert.equal(pipeline(['done']).status, 0);
    write('src/Basket/Coupons.cs', '// coupons v3 survives a crash\n');
    assert.match(stop().systemMessage, /test automation for DEMO-1 started in the background/);
    await crashed();
    assert.equal(stop()?.systemMessage.includes('resumed the interrupted test automation run for DEMO-1 at round 2 (attempt 1'), true, 'the Stop hook resumes it');
    await waitFor(() => !['starting', 'running'].includes(stateOf('DEMO-1').automation.status));
    const state = stateOf('DEMO-1');
    assert.equal(state.automation.status, 'verified', read(state.automation.log));
    assert.deepEqual([state.automation.recoveries, state.automation.progress], [0, null]);
    assert.equal(calls()['qe-automation'], 3, 'round 1 is not redone');
    assert.match(prompts().split('=== qe-automation #3')[1], /previous test automation run was interrupted[\s\S]*TC-DEMO-1-02 has no automated test/, 'the resumed round keeps its feedback');

    // A run that keeps crashing is escalated once its attempts are used up, and not restarted by itself.
    agentScript({ 'architecture-reviewer': [{ result: { verdict: 'APPROVED', summary: 'ok', findings: [] } }], 'qe-automation': [{ killRunner: 'automation' }] });
    write('src/Basket/Coupons.cs', '// coupons v3 crashes the runner\n');
    assert.match(stop().systemMessage, /started in the background/);
    await crashed();
    assert.match(pipeline(['resume', 'DEMO-1']).stdout, /resumed the interrupted test automation run for DEMO-1 at round 1 \(attempt 1/);
    await crashed();
    assert.match(qe(['resume']).stdout, /kept crashing and was escalated/);
    assert.equal(stateOf('DEMO-1').automation.status, 'crashed');
    assert.match(read('.agent-state/escalations/DEMO-1-automation.md'), /automation run crashed 2 times[\s\S]*resume DEMO-1 --force/);
    assert.equal(stop(), null, 'a crashed run waits for a person');
    assert.match(qe(['resume']).stdout, /No interrupted QE runs/);

    agentScript({ 'qe-automation': [{ writeTests: [1, 2, 3], result: { status: 'done' } }], 'qe-automation-verifier': [{ result: { score: 10, gaps: [] } }] });
    assert.match(pipeline(['resume', 'DEMO-1', '--force']).stdout, /resumed the interrupted test automation run/);
    await waitFor(() => !['starting', 'running'].includes(stateOf('DEMO-1').automation.status));
    assert.equal(stateOf('DEMO-1').automation.status, 'verified');
  } finally {
    write('scripts/pipeline/config.json', pipelineConfig);
  }
});

test('the Architecture Policy Pack gates each review round for code agents and loops until satisfied', async () => {
  const policyFile = path.join(repo, '..', `${path.basename(repo)}-policy.json`);
  const item = (outcome, rule) => ({ finding_id: `${rule}-abc`, rule_id: rule, rule_title: 'Rule title', category: 'security', outcome, file: 'src/Basket/Coupons.cs', line: 1, message: 'violation', fix: 'apply the pattern', patterns: ['PAT-X'], repeat_mistake: outcome === 'BLOCK' });
  fs.writeFileSync(policyFile, JSON.stringify([
    { decision: 'BLOCK', review_id: 'r1', summary: 'BLOCK: 1 blocking', action_items: [item('BLOCK', 'SEC-001')] },
    { decision: 'WARN', review_id: 'r2', summary: 'WARN: 1 warning', action_items: [item('WARN', 'OBS-001')] },
  ]));
  const config = JSON.parse(read('scripts/review/config.json'));
  config.review.policy.agent = 'scripts/review/review.mjs';
  config.review.policy.command = [process.execPath, fakePolicy];
  config.review.policy.lessonsCommand = [process.execPath, fakePolicy, 'get_lessons'];
  write('scripts/review/config.json', JSON.stringify(config, null, 2));
  agentScript({
    'architecture-reviewer': [{ result: { verdict: 'APPROVED', summary: 'ok', findings: [] } }],
    'qe-automation': [{ writeTests: [1, 2, 3], result: { status: 'done' } }],
    'qe-automation-verifier': [{ result: { score: 10, gaps: [] } }],
  });
  const env = { PIPELINE_FAKE_POLICY: policyFile, PIPELINE_FAKE_LESSONS: 'L1: read secrets from configuration (PAT-X).' };
  const stop = (payload = {}) => {
    const r = pipeline(['hook', 'stop'], { input: JSON.stringify(payload), env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const requests = () => fs.readFileSync(`${policyFile}.requests.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  try {
    assert.equal(pipeline(['start', 'DEMO-1']).status, 0);
    assert.equal(pipeline(['done']).status, 0);
    write('src/Basket/Coupons.cs', '// coupons v4 logs the coupon code\n');
    assert.equal(stop({ hook_event_name: 'SubagentStop', agent_type: 'Explore' }), null, 'non-code subagents are not reviewed');
    assert.equal(fs.existsSync(`${policyFile}.requests.jsonl`), false);

    const first = stop({ hook_event_name: 'SubagentStop', agent_type: 'implementer' });
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /round 1\/5 [\s\S]*Architecture Policy Pack: BLOCK[\s\S]*SEC-001 Rule title: violation \(repeat mistake[\s\S]*Approved pattern\(s\): PAT-X/);
    assert.match(first.reason, /denied for these rules before[\s\S]*L1: read secrets from configuration \(PAT-X\)\./, 'a repeat mistake hands the agent its lessons');
    assert.deepEqual(JSON.parse(fs.readFileSync(`${policyFile}.lessons.jsonl`, 'utf8')), { agent: 'implementer', limit: 5 });
    assert.deepEqual(jsonl('arch-reviews.jsonl').at(-1).findings, [{ severity: 'blocking', category: 'security', rule: 'SEC-001', file: 'src/Basket/Coupons.cs', line: 1, issue: 'SEC-001 Rule title: violation (repeat mistake: this agent was denied for this rule before)' }]);
    assert.equal(calls()['architecture-reviewer'], undefined, 'a policy BLOCK ends the round without an LLM review');
    assert.deepEqual([requests()[0].requester, requests()[0].checkpoint], [{ agent: 'implementer', task_id: 'DEMO-1', iteration: 1 }, 'code_review']);
    assert.ok(requests()[0].changed_files.includes('src/Basket/Coupons.cs'));

    write('src/Basket/Coupons.cs', '// coupons v5 logs a masked id\n');
    const approved = stop();
    assert.match(approved.systemMessage, /approved DEMO-1 \(round 2\)[\s\S]*Non-blocking notes:\n1\. \[minor\] src\/Basket\/Coupons\.cs:1 OBS-001/);
    assert.equal(requests()[1].previous_review_id, 'r1', 'the fix is re-reviewed as an iteration of the first review');
    assert.equal(calls()['architecture-reviewer'], 1);
    assert.deepEqual(jsonl('arch-reviews.jsonl').slice(-2).map((r) => [r.reviewer ?? 'architecture-reviewer', r.verdict]), [['arch-review-agent', 'CHANGES_REQUESTED'], ['architecture-reviewer', 'APPROVED']]);
    const policyDecisions = jsonl('decisions.jsonl').filter((d) => d.agent === 'arch-review-agent').slice(-2);
    assert.deepEqual(policyDecisions.map((d) => [d.decision, d.policy_decision, d.items[0].rule, d.items[0].repeat]), [['changes-requested', 'BLOCK', 'SEC-001', true], ['approved', 'WARN', 'OBS-001', false]], 'policy passes are logged too');
    await waitFor(() => !['starting', 'running'].includes(stateOf('DEMO-1').automation.status));

    write('.github/agents/lessons/implementer.md', '## L1: Read secrets from configuration\n');
    assert.match(JSON.parse(pipeline(['hook', 'session-start']).stdout).additionalContext, /Architecture lessons from earlier review denials[\s\S]*L1: Read secrets from configuration/, 'the main session gets the implementer lessons');
  } finally {
    for (const suffix of ['', '.requests.jsonl', '.lessons.jsonl']) fs.rmSync(policyFile + suffix, { force: true });
    fs.rmSync(path.join(repo, '.github/agents/lessons/implementer.md'), { force: true });
  }
});

test('product bugs found by the integration tests are logged with their reasons and handed to the implementer', () => {
  agentScript({
    'qe-automation': [{ result: { status: 'product-bug', summary: 'coupon expiry is not checked', bugs: [{ case: 'TC-DEMO-1-02', expected: '400', actual: '200', location: 'src/Basket/Coupons.cs:1', why: 'no expiry check' }] } }],
  });
  const result = qe(['automate', 'DEMO-1', '--skip-tests']);
  assert.equal(result.status, 1, result.stderr);
  const bug = jsonl('decisions.jsonl').at(-1);
  assert.deepEqual([bug.stage, bug.agent, bug.subject, bug.decision, bug.reason], ['automation', 'qe-automation', 'implementer', 'product-bug', 'coupon expiry is not checked']);
  assert.deepEqual(bug.items, [{ case: 'TC-DEMO-1-02', expected: '400', actual: '200', location: 'src/Basket/Coupons.cs:1', reason: 'no expiry check' }]);
  assert.match(JSON.parse(pipeline(['hook', 'session-start']).stdout).additionalContext, /QE found implementation bugs:\n- TC-DEMO-1-02: expected 400, got 200 \(no expiry check\) at src\/Basket\/Coupons\.cs:1/);
});

test('the lessons run holds a factory retro over the decision log and keeps only edits to allowed paths', () => {
  agentScript({
    'qe-lessons': [{
      writeFiles: { 'docs/ai-pipeline/qe.md': '# QE\n\nState the expiry rule.\n', 'src/Basket/Coupons.cs': '// not allowed\n' },
      result: { status: 'done', proposals: [{ file: 'docs/ai-pipeline/qe.md', why: 'TC-DEMO-1-02 caught a missing expiry check' }] },
    }],
  });
  const result = qe(['lessons', '--no-push']);
  assert.equal(result.status, 0, result.stderr);
  const { status, branch } = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  assert.equal(status, 'committed');
  assert.match(prompts(), /## Factory retro[\s\S]*"casesThatCaughtBugs": \[\s*\{\s*"story": "DEMO-1",\s*"case": "TC-DEMO-1-02"/);
  assert.deepEqual(gitc('show', '--name-only', '--format=', branch).stdout.trim().split('\n'), ['docs/ai-pipeline/qe.md']);
  assert.match(gitc('log', '-1', '--format=%B', branch).stdout, /Proposed factory changes \(needs human review\)[\s\S]*`docs\/ai-pipeline\/qe\.md`: TC-DEMO-1-02 caught a missing expiry check/);
  gitc('branch', '-D', branch);
});

test('a lessons run killed mid-retro is resumed from the start, then escalated after repeated crashes', async () => {
  const runFile = path.join(repo, '.agent-state/lessons-run.json');
  const runOf = () => JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const lastTs = () => JSON.parse(read('.agent-state/lessons-last.json')).ts;
  const before = lastTs();
  agentScript({
    'qe-lessons': [
      { writeFiles: { 'docs/ai-pipeline/qe.md': '# QE\n\nfirst attempt\n' }, killPidIn: runFile },
      { writeFiles: { 'docs/ai-pipeline/qe.md': '# QE\n\nsecond attempt\n' }, result: { status: 'done', proposals: [] } },
    ],
  });
  const killed = qe(['lessons', '--no-push']);
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const dead = runOf();
  assert.deepEqual([dead.status, dead.phase, fs.existsSync(dead.worktree)], ['running', 'agent', true]);
  assert.equal(lastTs(), before, 'a crashed run must stay due');
  // Not skipped as "not due": the crashed run is started over, its leftover worktree and branch removed.
  const rerun = qe(['lessons', '--if-due']);
  assert.match(rerun.stderr, /interrupted; starting it over/);
  assert.equal(runOf().status, 'done');
  assert.equal(calls()['qe-lessons'], 2);
  assert.equal(fs.existsSync(dead.worktree), false);
  assert.match(gitc('show', `${dead.branch}:docs/ai-pipeline/qe.md`).stdout, /second attempt/);
  assert.notEqual(lastTs(), before);
  gitc('branch', '-D', dead.branch);

  fs.writeFileSync(runFile, JSON.stringify({ ...dead, status: 'running', pid: 999999, boot: null, recoveries: 3, retryAt: null }));
  assert.match(qe(['resume']).stdout, /lessons and factory retro run kept crashing and was escalated/);
  assert.equal(runOf().status, 'crashed');
  assert.ok(fs.existsSync(path.join(repo, '.agent-state/escalations/lessons-qe.md')));
  assert.match(qe(['resume']).stdout, /No interrupted QE runs/);
  agentScript({ 'qe-lessons': [{ writeFiles: { 'docs/ai-pipeline/qe.md': '# QE\n\nforced\n' }, result: { status: 'done', proposals: [] } }] });
  assert.match(qe(['resume', '--force']).stdout, /resumed the interrupted lessons and factory retro run \(attempt 1/);
  await waitFor(() => runOf().status === 'done');
  assert.equal(fs.existsSync(path.join(repo, '.agent-state/escalations/lessons-qe.md')), false);
  assert.equal(calls()['qe-lessons'], 1);
  gitc('branch', '-D', runOf().branch);
});

test('pipeline start resets the review rounds even when hooks are disabled', () => {
  const file = `.agent-state/stories/DEMO-1.json`;
  const state = stateOf('DEMO-1');
  Object.assign(state.review, { rounds: 4, lastVerdict: 'CHANGES_REQUESTED' });
  write(file, JSON.stringify(state));
  const r = pipeline(['start', 'DEMO-1'], { env: { PIPELINE_DISABLE: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([stateOf('DEMO-1').review.rounds, stateOf('DEMO-1').review.lastVerdict], [0, null]);
});

test('an interrupted review round runs again on the next stop, escalates after repeated crashes, and resume --force retries it', () => {
  const review = (args, input = '{}') => {
    const r = cli('scripts/review/review.mjs', args, { input });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const stop = () => {
    const out = review(['hook', 'stop']);
    return out ? JSON.parse(out) : null;
  };
  const implHash = () => spawnSync(process.execPath, ['--input-type=module', '-e', "import { loadConfig } from './scripts/pipeline/lib/config.mjs'; import { implChanges } from './scripts/pipeline/lib/git.mjs'; console.log(implChanges(loadConfig('review')).hash);"], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  // What a review round leaves behind when its process dies mid-run.
  const crashed = (recoveries = 0) => {
    const state = stateOf('DEMO-1');
    Object.assign(state.review, { recoveries, inProgress: { hash: implHash(), round: state.review.rounds + 1, pid: 999999, boot: null, startedAt: new Date().toISOString() } });
    write('.agent-state/stories/DEMO-1.json', JSON.stringify(state));
  };
  const config = JSON.parse(read('scripts/review/config.json'));
  config.review.policy.enabled = false;
  write('scripts/review/config.json', JSON.stringify(config, null, 2));
  agentScript({ 'architecture-reviewer': [{ result: { verdict: 'APPROVED', summary: 'ok', findings: [] } }] });
  assert.equal(pipeline(['start', 'DEMO-1']).status, 0);
  assert.equal(pipeline(['done']).status, 0);

  write('src/Basket/Coupons.cs', '// coupons v6\n');
  crashed();
  assert.match(review(['resume']), /DEMO-1: architecture review round 1 was interrupted; it runs again when the code agent finishes its turn/);
  assert.match(review(['hook', 'session-start']), /round 1 was interrupted/);
  assert.match(pipeline(['resume']).stdout, /\[review\]\nDEMO-1: architecture review round 1 was interrupted/);
  assert.match(stop().systemMessage, /approved DEMO-1 \(round 1\)/);
  assert.deepEqual([stateOf('DEMO-1').review.inProgress, stateOf('DEMO-1').review.recoveries, calls()['architecture-reviewer']], [null, 0, 1]);

  write('src/Basket/Coupons.cs', '// coupons v7\n');
  crashed(3);
  assert.match(stop().systemMessage, /architecture review of DEMO-1 crashed 3 times/);
  assert.equal(stateOf('DEMO-1').review.lastVerdict, 'CRASHED');
  assert.match(read('.agent-state/escalations/DEMO-1-review.md'), /review round crashed 3 times/);
  assert.equal(stop(), null, 'a crashed review waits for a human');
  assert.equal(calls()['architecture-reviewer'], 1);
  assert.match(review(['resume', 'DEMO-1']), /crashed 3 times; run `node scripts\/review\/review.mjs resume DEMO-1 --force`/);

  assert.match(review(['resume', 'DEMO-1', '--force']), /review reset/);
  assert.equal(fs.existsSync(path.join(repo, '.agent-state/escalations/DEMO-1-review.md')), false);
  assert.match(stop().systemMessage, /approved DEMO-1/);
  assert.equal(calls()['architecture-reviewer'], 2);
});

test('commits and merges start no agent (stories are board issues, not files), and a story with no plan yet can be pushed', async () => {
  const branch = gitc('branch', '--show-current').stdout.trim();
  gitc('add', '-A');
  gitc('commit', '-qm', 'wip', '--allow-empty');
  gitc('checkout', '-qb', 'feature/DEMO-9');
  try {
    agentScript({ 'qe-plan': [{ writePlan: happySad }], 'qe-plan-verifier': [{ result: { score: 10, gaps: [] } }] });
    seedTicket(repo, { key: 'DEMO-9', slug: 'DEMO-9-gift-cards', text: '# DEMO-9 Gift cards\n\nRule: a gift card pays for the basket.\n' });
    write('src/Basket/GiftCards.cs', '// gift cards\n');
    gitc('add', '-A');
    gitc('commit', '-qm', 'DEMO-9: gift cards');

    assert.equal(pipeline(['git-hook', 'post-commit']).status, 0);
    assert.equal(pipeline(['git-hook', 'post-merge']).status, 0);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(calls(), {}, 'no agent runs on commit or merge by default');

    const head = gitc('rev-parse', 'HEAD').stdout.trim();
    const prePush = pipeline(['git-hook', 'pre-push'], { input: `refs/heads/feature/DEMO-9 ${head} refs/heads/feature/DEMO-9 ${'0'.repeat(40)}\n` });
    assert.equal(prePush.status, 0, prePush.stdout + prePush.stderr);
    assert.equal(qe(['check', '--changed-from', 'main']).status, 0);

    // Even with qe.autoPlan a commit plans nothing: `board fetch` (changed stories) or `qe plan` does.
    gitc('config', 'qe.autoPlan', 'true');
    assert.equal(pipeline(['git-hook', 'post-commit']).status, 0);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(calls(), {});
    assert.equal(qe(['plan', 'DEMO-9']).status, 0);
    assert.equal(calls()['qe-plan-verifier'], 1);
  } finally {
    gitc('config', '--unset', 'qe.autoPlan');
    gitc('checkout', '-qf', branch);
  }
});

test('story guard: agents see only the tickets handed to the pipeline', () => {
  const epic = seedTicket(repo, { key: 'epic-coupons', type: 'epic', text: '# Epic: Coupons\n' });
  const other = seedTicket(repo, { key: 'DEMO-2', text: '# DEMO-2 Gift wrap\n', mockups: { 'DEMO-2-wrap/Main.png': 'png' } });
  seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-apply-coupon', text: read(STORY), mockups: { 'DEMO-1-coupon/Main.dc.html': '<html></html>' } });
  const guard = (tool_name, tool_input, env = {}) => {
    const r = pipeline(['hook', 'pre-tool'], { input: JSON.stringify({ tool_name, tool_input, cwd: repo }), env: { PIPELINE_CHILD: '1', ...env } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow';
  };
  try {
    fs.rmSync(path.join(repo, '.agent-state/active-story'), { force: true });
    assert.equal(guard('Read', { file_path: STORY }), 'deny', 'nothing handed over yet');

    assert.equal(pipeline(['start', 'DEMO-1']).status, 0);
    assert.equal(guard('Read', { file_path: path.join(repo, STORY) }), 'allow', 'the active story');
    assert.equal(guard('Edit', { file_path: STORY }), 'allow');
    assert.equal(guard('Read', { file_path: `${CACHE}/DEMO-1/mockups/DEMO-1-coupon/Main.dc.html` }), 'allow', "the active story's own mockups");
    assert.equal(guard('Read', { file_path: other }), 'deny');
    assert.equal(guard('Read', { file_path: `${CACHE}/DEMO-2/mockups/DEMO-2-wrap/Main.png` }), 'deny', "another story's mockups");
    assert.equal(guard('Read', { file_path: epic }), 'deny');
    assert.equal(guard('Glob', { pattern: `${CACHE}/**/*.md` }), 'deny');
    assert.equal(guard('Grep', { pattern: 'coupon', path: CACHE }), 'deny');
    assert.equal(guard('Grep', { pattern: CACHE, path: 'src' }), 'allow', 'a grep regex is not a path');
    assert.equal(guard('Bash', { command: `cat ${STORY}` }), 'allow');
    assert.equal(guard('Bash', { command: `cat ${STORY} ./${epic} | head` }), 'deny');
    assert.equal(guard('Bash', { command: 'ls src' }), 'allow');
    assert.equal(guard('read_many_files', { paths: ['src/Basket/Coupons.cs', other] }), 'deny');

    // implement run hands over ticket folders (or keys); nothing else in the cache opens up.
    assert.equal(guard('Read', { file_path: other }, { PIPELINE_STORY_SOURCES: path.join(repo, CACHE, 'DEMO-2') }), 'allow', 'a ticket folder given to implement run');
    assert.equal(guard('Read', { file_path: other }, { PIPELINE_STORY_SOURCES: 'DEMO-2' }), 'allow', 'a ticket key given to implement run');
    assert.equal(guard('Read', { file_path: epic }, { PIPELINE_STORY_SOURCES: 'DEMO-2' }), 'deny');
    assert.equal(guard('Read', { file_path: other }, { PIPELINE_DISABLE: '1' }), 'allow');
  } finally {
    fs.rmSync(path.join(repo, '.agent-state/active-story'), { force: true });
  }
});
