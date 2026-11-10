// End-to-end run of `pipeline implement` in a throwaway git repo, with the scripted fake agent CLI
// standing in for the implementer, the reviewer and the QE agents.
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
const calls = () => JSON.parse(fs.readFileSync(`${scriptFile}.calls.json`, 'utf8'));
const prompts = () => fs.readFileSync(`${scriptFile}.prompts.log`, 'utf8');

function pipeline(args) {
  const env = { ...process.env, PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main' };
  for (const k of ['PIPELINE_CHILD', 'PIPELINE_DISABLE', 'PIPELINE_ROOT']) delete env[k];
  return spawnSync(process.execPath, ['scripts/pipeline/pipeline.mjs', ...args], { cwd: repo, encoding: 'utf8', env });
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'implement-e2e-')));
  repo = path.join(tmp, 'shop');
  incoming = path.join(tmp, 'incoming');
  scriptFile = path.join(tmp, 'agent.json');
  for (const dir of ['scripts/pipeline', 'scripts/review', 'scripts/qe', 'scripts/implement', 'scripts/pr-check']) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  fs.cpSync(path.join(source, '.github/agents'), path.join(repo, '.github/agents'), { recursive: true });
  const qeConfig = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/qe/config.json'), 'utf8'));
  qeConfig.precheck.runTests = false;
  write(repo, 'scripts/qe/config.json', JSON.stringify(qeConfig, null, 2));
  const implConfig = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/implement/config.json'), 'utf8'));
  implConfig.implement.qePollSec = 0.1;
  write(repo, 'scripts/implement/config.json', JSON.stringify(implConfig, null, 2));
  const prCheckConfig = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/pr-check/config.json'), 'utf8'));
  prCheckConfig.prCheck.hook.enabled = false;
  write(repo, 'scripts/pr-check/config.json', JSON.stringify(prCheckConfig, null, 2));
  write(repo, '.gitignore', '.agent-state/\n');
  write(repo, 'src/Basket/Coupons.cs', '// coupons\n');
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.email', 'qe@example.com']);
  sh(repo, 'git', ['config', 'user.name', 'QE Test']);
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-qm', 'init']);

  const rule = 'Rule: a valid coupon gives 10% off; an expired coupon is rejected with 400.\n';
  write(incoming, 'DEMO-1-apply-coupon.md', `# DEMO-1 Apply coupon\n\n${rule}`);
  write(incoming, 'DEMO-2-coupon-history.md', `# DEMO-2 Coupon history\n\n* **Blocked by:** [DEMO-1](DEMO-1-apply-coupon.md)\n\n${rule}`);
  write(incoming, 'DEMO-3-loyalty.md', `# DEMO-3 Loyalty\n\n${rule}`);
  write(incoming, 'DEMO-4-loyalty-tiers.md', `# DEMO-4 Loyalty tiers\n\n* **Blocked by:** [DEMO-3](DEMO-3-loyalty.md)\n\n${rule}`);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

test('implement run: each story gets a worktree and branch, loops with the review, waits for verified tests and stacks dependents', async () => {
  const happySad = [{ title: 'Valid coupon applies', type: 'happy' }, { title: 'Expired coupon rejected', type: 'sad' }];
  const blocking = { verdict: 'CHANGES_REQUESTED', summary: 'no owner check', findings: [{ severity: 'blocking', category: 'security', file: 'src/Basket/Coupons.cs', line: 1, issue: 'no owner check', fix: 'check buyer id' }] };
  fs.writeFileSync(
    scriptFile,
    JSON.stringify({
      implementer: [
        { writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', reason: 'coupon applied' } },
        { writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', reason: 'owner check added' } },
        { writeImpl: 'src/Basket/History.cs', result: { status: 'done', reason: 'history' } },
        { result: { status: 'blocked', reason: 'loyalty provider is an open question' } },
      ],
      'architecture-reviewer': [{ result: blocking }, { result: { verdict: 'APPROVED', summary: 'ok', findings: [] } }],
      'qe-plan': [{ writePlan: happySad }],
      'qe-plan-verifier': [{ result: { score: 10, summary: 'ok', gaps: [] } }],
      'qe-automation': [{ writeTests: [1, 2], result: { status: 'done' } }],
      'qe-automation-verifier': [{ result: { score: 10, gaps: [] } }],
    }),
  );

  const dry = pipeline(['implement', 'run', incoming, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /1\. DEMO-1 +feat\/demo-1-apply-coupon <- main\n 2\. DEMO-2 +feat\/demo-2-coupon-history <- feat\/demo-1-apply-coupon {2}\(blocked by DEMO-1\)/);
  assert.ok(!fs.existsSync(`${scriptFile}.calls.json`), 'a dry run starts no agents');

  const result = pipeline(['implement', 'run', incoming]);
  assert.equal(result.status, 1, 'not every story finished');
  assert.match(result.stdout, /DEMO-1 +done +feat\/demo-1-apply-coupon/);
  assert.match(result.stdout, /DEMO-2 +done +feat\/demo-2-coupon-history/);
  assert.match(result.stdout, /DEMO-3 +blocked .*\n +loyalty provider is an open question/);
  assert.match(result.stdout, /DEMO-4 +skipped .*\n +blocker DEMO-3 ended blocked/);
  assert.deepEqual(calls(), { implementer: 4, 'architecture-reviewer': 3, 'qe-plan': 2, 'qe-plan-verifier': 2, 'qe-automation': 2, 'qe-automation-verifier': 2 });
  assert.match(prompts(), /=== implementer #2[\s\S]*Address this feedback[\s\S]*no owner check[\s\S]*Fix: check buyer id/, 'review findings go back to the implementer');
  assert.match(prompts(), /=== implementer #1 \(child=1\)[\s\S]*headless under `pipeline implement`[\s\S]*AGENT_RESULT/);

  const wt1 = path.join(tmp, 'shop-worktrees', 'demo-1');
  const wt2 = path.join(tmp, 'shop-worktrees', 'demo-2');
  assert.equal(sh(wt1, 'git', ['branch', '--show-current']), 'feat/demo-1-apply-coupon');
  assert.equal(sh(wt1, 'git', ['status', '--porcelain']), '', 'everything is committed');
  assert.deepEqual(sh(wt1, 'git', ['log', '--format=%s', 'main..HEAD']).split('\n'), [
    'DEMO-1: Add verified test plan and automated tests',
    'DEMO-1: Implementation',
    'DEMO-1: Implementation',
    'DEMO-1: Add story',
  ]);
  assert.ok(fs.existsSync(path.join(wt1, 'product-research/stories/DEMO-1-apply-coupon.md')));
  assert.ok(fs.existsSync(path.join(wt1, 'tests/plans/DEMO-1-apply-coupon/_index.md')));
  const metrics = fs.readFileSync(path.join(wt1, '.agent-metrics/implement-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(metrics.map((m) => [m.story, m.outcome, m.implementer_runs, m.review_blocks]), [['DEMO-1', 'done', 2, 1]]);

  assert.equal(sh(wt2, 'git', ['merge-base', '--is-ancestor', 'feat/demo-1-apply-coupon', 'HEAD']), '', 'DEMO-2 is stacked on DEMO-1');
  assert.equal(sh(wt2, 'git', ['log', '-1', '--format=%s']), 'DEMO-2: Add verified test plan and automated tests');
  assert.ok(!fs.existsSync(path.join(tmp, 'shop-worktrees', 'demo-4')), 'a story whose blocker failed never starts');
  assert.equal(sh(repo, 'git', ['branch', '--show-current']), 'main', 'the main checkout is untouched');

  const status = pipeline(['implement', 'status']);
  assert.match(status.stdout, /DEMO-2 +finished +done +feat\/demo-2-coupon-history/);
  assert.match(status.stdout, /DEMO-4 +finished +skipped/);
});
