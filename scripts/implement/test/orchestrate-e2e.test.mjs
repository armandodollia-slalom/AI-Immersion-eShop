// End-to-end orchestrated `pipeline implement run` in a throwaway git repo: the scripted fake agent CLI
// plays the orchestrator, the pair implementers and verifiers, the reviewer and the QE agents.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fakeAgent = path.join(source, 'scripts/pipeline/test/fixtures/fake-agent.mjs');
let tmp;
let repo;
let incoming;
let scriptFile;

const sh = (cwd, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function pipeline(args) {
  const env = { ...process.env, PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main' };
  for (const k of ['PIPELINE_CHILD', 'PIPELINE_DISABLE', 'PIPELINE_ROOT', 'IMPLEMENT_ORCHESTRATE']) delete env[k];
  return spawnSync(process.execPath, ['scripts/pipeline/pipeline.mjs', ...args], { cwd: repo, encoding: 'utf8', env });
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrate-e2e-')));
  repo = path.join(tmp, 'shop');
  incoming = path.join(tmp, 'incoming');
  scriptFile = path.join(tmp, 'agent.json');
  for (const dir of ['scripts/pipeline', 'scripts/review', 'scripts/qe', 'scripts/implement', 'scripts/pr-check', 'scripts/board', 'scripts/models', 'scripts/pr-video']) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  fs.cpSync(path.join(source, '.github/agents'), path.join(repo, '.github/agents'), { recursive: true });
  const qeConfig = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/qe/config.json'), 'utf8'));
  qeConfig.precheck.runTests = false;
  write(repo, 'scripts/qe/config.json', JSON.stringify(qeConfig, null, 2));
  const implConfig = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/implement/config.json'), 'utf8'));
  Object.assign(implConfig.implement, { qePollSec: 0.1, checks: [], unitTests: null, prepareCmd: null });
  write(repo, 'scripts/implement/config.json', JSON.stringify(implConfig, null, 2));
  write(repo, '.gitignore', '.agent-state/\nartifacts/\n');
  write(repo, 'src/Catalog.API/Api.cs', '// catalog\n');
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.email', 'qe@example.com']);
  sh(repo, 'git', ['config', 'user.name', 'QE Test']);
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-qm', 'init']);
  write(incoming, 'DEMO-1-coupons.md', '# DEMO-1: [BE - Catalog.API, Basket.API] - Coupons\n\n## Acceptance Criteria\n\n- a valid coupon gives 10% off\n- an expired coupon is rejected with 400\n');
});

// The runner leaves detached background work (QE runs) that can still be writing into the repo when
// the tests end. Give it a moment to finish, stop what is left, then remove the folder with retries,
// so cleanup never fails with "directory not empty".
after(() => {
  const running = () => (spawnSync('pgrep', ['-f', tmp], { encoding: 'utf8' }).stdout ?? '').split('\n').map(Number).filter((pid) => pid && pid !== process.pid);
  for (let i = 0; i < 50 && running().length; i++) spawnSync('sleep', ['0.1']);
  for (const pid of running()) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const sub = (id, owns, over = {}) => ({ id, goal: `build ${id}`, acceptance: [`${id} works`], owns, dependsOn: [], modelClass: 'medium', verify: 'code', modelReason: 'normal', verifyReason: 'api', expectedFiles: 1, expectedLoc: 3, confidence: 0.8, alternatives: [{ option: 'self', reason: 'two services' }], ...over });

test('implement run (orchestrated): plan, pairs, merges, integration, review loop, QE, decision log', () => {
  const plan = { mode: 'delegate', modeReason: 'two services', splitReason: 'one per service', features: { services: ['Catalog.API', 'Basket.API'], estimatedSize: 'small' }, subtasks: [sub('catalog', ['src/Catalog.API/**']), sub('basket', ['src/Basket.API/**'], { dependsOn: ['catalog'] })] };
  const blocking = { verdict: 'CHANGES_REQUESTED', summary: 'no owner check', findings: [{ severity: 'blocking', category: 'security', file: 'src/Basket.API/Coupons.cs', line: 1, issue: 'no owner check', fix: 'check buyer id' }] };
  fs.writeFileSync(
    scriptFile,
    JSON.stringify({
      implementer: [{ result: plan }, { result: { status: 'done', reason: 'integrated' } }, { writeImpl: 'src/Basket.API/Coupons.cs', result: { status: 'done', reason: 'owner check' } }],
      'pair-implementer': [{ writeFiles: { 'src/Catalog.API/Coupons.cs': '// catalog coupons\n' }, result: { status: 'done' } }, { writeFiles: { 'src/Basket.API/Coupons.cs': '// basket coupons\n' }, result: { status: 'done' } }],
      'pair-verifier': [{ result: { verdict: 'APPROVED', summary: 'ok', findings: [] } }],
      'architecture-reviewer': [{ result: blocking }, { result: { verdict: 'APPROVED', summary: 'ok', findings: [] } }],
      'qe-plan': [{ writePlan: [{ title: 'Valid coupon applies', type: 'happy' }, { title: 'Expired coupon rejected', type: 'sad' }] }],
      'qe-plan-verifier': [{ result: { score: 10, summary: 'ok', gaps: [] } }],
      'qe-automation': [{ writeTests: [1, 2], result: { status: 'done' } }],
      'qe-automation-verifier': [{ result: { score: 10, gaps: [] } }],
    }),
  );

  const result = pipeline(['implement', 'run', incoming]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /DEMO-1 +done +feat\/demo-1-coupons/);
  const calls = JSON.parse(fs.readFileSync(`${scriptFile}.calls.json`, 'utf8'));
  assert.deepEqual([calls.implementer, calls['pair-implementer'], calls['pair-verifier'], calls['architecture-reviewer']], [3, 2, 2, 2]);
  const prompts = fs.readFileSync(`${scriptFile}.prompts.log`, 'utf8');
  assert.match(prompts, /=== implementer #1 [\s\S]*in PLAN mode/);
  assert.match(prompts, /=== implementer #2 [\s\S]*in INTEGRATE mode[\s\S]*- catalog: build catalog/);
  assert.match(prompts, /=== pair-verifier #1 [\s\S]*\+\/\/ catalog coupons/);

  const wt = path.join(tmp, 'shop-worktrees', 'demo-1');
  assert.equal(sh(wt, 'git', ['status', '--porcelain']), '', 'everything is committed');
  assert.deepEqual(sh(wt, 'git', ['log', '--merges', '--format=%s', 'main..HEAD']).split('\n'), ['DEMO-1: Merge subtask basket', 'DEMO-1: Merge subtask catalog']);
  assert.ok(!fs.existsSync(`${wt}--catalog`) && !fs.existsSync(`${wt}--basket`), 'subtask worktrees removed');

  const metrics = path.join(wt, '.agent-metrics');
  const decision = jsonl(path.join(metrics, 'decisions.jsonl')).find((d) => d.stage === 'implement-plan');
  assert.equal(decision.decision, 'plan-written');
  assert.equal(decision.features.acceptanceCriteria, 2);
  decision.decisionId = decision.decision_id;
  const runs = jsonl(path.join(metrics, 'subtask-runs.jsonl'));
  assert.deepEqual(runs.map((r) => [r.subtaskId, r.approved, r.decisionId === decision.decisionId]), [['catalog', true, true], ['basket', true, true]]);
  const outcomes = jsonl(path.join(metrics, 'decision-outcomes.jsonl'));
  const escaped = outcomes.find((o) => o.type === 'escaped');
  assert.deepEqual([escaped.subtaskId, escaped.source, escaped.findings[0].file], ['basket', 'arch-review', 'src/Basket.API/Coupons.cs'], 'the review finding is credited to the subtask that owns the file');
  const story = outcomes.find((o) => o.type === 'story');
  assert.deepEqual([story.outcome, story.decisionId, story.reviewBlocks], ['done', decision.decisionId, 1]);
  const run = jsonl(path.join(metrics, 'implement-runs.jsonl'))[0];
  assert.deepEqual([run.mode, run.subtasks, run.agent_runs], ['delegate', 2, 7]);
  assert.equal(sh(wt, 'git', ['log', '-1', '--format=%s']), 'DEMO-1: Add verified test plan and automated tests');
  assert.match(sh(wt, 'git', ['show', '--stat', '--format=', 'HEAD']), /decision-outcomes\.jsonl/);

  const status = pipeline(['implement', 'status']);
  assert.match(status.stdout, /DEMO-1 +finished +done[\s\S]*delegate \(decision [0-9a-f]{8}\), 7 agent runs[\s\S]*catalog +merged/);

  fs.cpSync(metrics, path.join(repo, '.agent-metrics'), { recursive: true });
  const report = pipeline(['implement', 'decisions', '--story', 'DEMO-1', '--json']);
  assert.equal(report.status, 0, report.stderr); const rows = JSON.parse(report.stdout);
  assert.deepEqual(rows.map((r) => [r.subtaskId, r.labels]), [['catalog', ['over-provisioned']], ['basket', ['over-provisioned', 'weak-verification']]]);
});
