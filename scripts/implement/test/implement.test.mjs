// End-to-end run of the implement stage in a throwaway git repo: `pipeline implement` creates the
// story's worktree, runs the (fake) implementation agent there with hooks enabled, loops on review
// findings, and hands the approved code to QE, which writes the missing plan first.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fakeAgent = path.join(source, 'scripts', 'pipeline', 'test', 'fixtures', 'fake-agent.mjs');
let repo;
let scriptFile;

const sh = (cmd, args, cwd = repo) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const calls = () => (fs.existsSync(`${scriptFile}.calls.json`) ? json(`${scriptFile}.calls.json`) : {});
const prompts = () => fs.readFileSync(`${scriptFile}.prompts.log`, 'utf8');

function pipeline(args, env = {}) {
  const base = { ...process.env };
  delete base.PIPELINE_CHILD;
  delete base.PIPELINE_DISABLE;
  return spawnSync(process.execPath, ['scripts/pipeline/pipeline.mjs', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...base, PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', ...env },
  });
}

async function waitFor(predicate, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for background run');
}

const STORY = 'product-research/stories/DEMO-1-apply-coupon.md';
const WORKTREE = '.claude/worktrees/demo-1';

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-e2e-'));
  scriptFile = path.join(repo, '..', `${path.basename(repo)}-agent.json`);
  for (const dir of ['scripts/pipeline', 'scripts/implement', 'scripts/review', 'scripts/qe']) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  fs.cpSync(path.join(source, '.github/agents'), path.join(repo, '.github/agents'), { recursive: true });
  const qeConfig = json(path.join(repo, 'scripts/qe/config.json'));
  qeConfig.precheck.runTests = false;
  write('scripts/qe/config.json', JSON.stringify(qeConfig, null, 2));
  write('.gitignore', '.agent-state/\n.claude/worktrees/\n');
  write(STORY, '# DEMO-1 Apply coupon\n\nRule: a valid coupon gives 10% off; an expired coupon is rejected with 400.\n');
  write('src/Basket/Coupons.cs', '// coupons\n');
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'qe@example.com']);
  sh('git', ['config', 'user.name', 'QE Test']);
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'init']);
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  for (const suffix of ['', '.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
});

test('pipeline implement: worktree per story, implementer loops on review findings, then QE writes the plan and tests', async () => {
  const blocking = { verdict: 'CHANGES_REQUESTED', summary: 'bypasses ownership check', findings: [{ severity: 'blocking', category: 'security', file: 'src/Basket/Coupons.cs', line: 1, issue: 'no owner check', fix: 'check buyer id' }] };
  fs.writeFileSync(scriptFile, JSON.stringify({
    implementer: [
      { writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', summary: 'coupons' } },
      { writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', summary: 'owner check added' } },
    ],
    'architecture-reviewer': [{ result: blocking }, { result: { verdict: 'APPROVED', summary: 'ok', findings: [] } }],
    'qe-plan': [{ writePlan: [{ title: 'Valid coupon applies', type: 'happy' }, { title: 'Expired coupon rejected', type: 'sad' }] }],
    'qe-plan-verifier': [{ result: { score: 10, gaps: [] } }],
    'qe-automation': [{ writeTests: [1, 2], result: { status: 'done' } }],
    'qe-automation-verifier': [{ result: { score: 10, gaps: [] } }],
  }));

  const run = pipeline(['implement', 'DEMO-1']);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /DEMO-1: approved after 2 run\(s\) in \.claude\/worktrees\/demo-1 \(feat\/demo-1-apply-coupon\)/);

  // The work happened in the story's worktree on its own branch; the main checkout is untouched.
  assert.equal(sh('git', ['branch', '--show-current'], path.join(repo, WORKTREE)).trim(), 'feat/demo-1-apply-coupon');
  assert.equal(fs.readFileSync(path.join(repo, 'src/Basket/Coupons.cs'), 'utf8'), '// coupons\n');
  assert.match(fs.readFileSync(path.join(repo, WORKTREE, 'src/Basket/Coupons.cs'), 'utf8'), /fixed 1/);

  // Hooks stay enabled for the implementer (empty PIPELINE_CHILD), and run 2 gets the review findings.
  assert.match(prompts(), /=== implementer #1 \(child=\) ===[\s\S]*The AI pipeline started you/);
  assert.match(prompts(), /=== implementer #2 \(child=\) ===[\s\S]*round 1\/5[\s\S]*no owner check[\s\S]*Fix every finding/);

  const wtState = () => json(path.join(repo, WORKTREE, '.agent-state/stories/DEMO-1.json'));
  assert.equal(wtState().review.lastVerdict, 'APPROVED');
  assert.equal(json(path.join(repo, '.agent-state/stories/DEMO-1.json')).implement.status, 'approved');

  await waitFor(() => !['starting', 'running'].includes(wtState().automation.status));
  assert.equal(wtState().automation.status, 'verified');
  assert.deepEqual(calls(), { implementer: 2, 'architecture-reviewer': 2, 'qe-plan': 1, 'qe-plan-verifier': 1, 'qe-automation': 1, 'qe-automation-verifier': 1 });

  const status = pipeline(['status', 'DEMO-1']);
  assert.match(status.stdout, /DEMO-1 +implement=approved \(runs 2\) worktree=\.claude\/worktrees\/demo-1 review=APPROVED automation=verified/);
  const runs = fs.readFileSync(path.join(repo, WORKTREE, '.agent-metrics/implement-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(runs.map((r) => [r.run, r.status]), [[1, 'done'], [2, 'done']]);
});

test('pipeline implement: a blocked implementer escalates instead of looping', () => {
  fs.writeFileSync(scriptFile, JSON.stringify({ implementer: [{ result: { status: 'blocked', reason: 'DEMO-0 is not merged' } }] }));
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  write('product-research/stories/DEMO-2-remove-coupon.md', '# DEMO-2 Remove coupon\n\nBlocked by DEMO-0.\n');
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'story 2']);

  const run = pipeline(['implement', 'DEMO-2']);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /DEMO-2: blocked after 1 run\(s\)[\s\S]*DEMO-0 is not merged/);
  assert.deepEqual(calls(), { implementer: 1 });
  assert.ok(fs.existsSync(path.join(repo, '.agent-state/escalations/DEMO-2-implement.md')));
});

test('pipeline implement: refuses a story that is not on the base ref', () => {
  write('product-research/stories/DEMO-3-draft.md', '# DEMO-3 Draft\n');
  const run = pipeline(['implement', 'DEMO-3']);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /is not on main; merge the story before implementing it/);
});
