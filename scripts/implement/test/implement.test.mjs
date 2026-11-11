// End-to-end run of `pipeline implement` in a throwaway git repo, with the scripted fake agent CLI
// standing in for the implementer, the reviewer and the QE agents.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CACHE, seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';

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
  scriptFile = path.join(tmp, 'agent.json');
  for (const dir of ['scripts/pipeline', 'scripts/review', 'scripts/qe', 'scripts/implement', 'scripts/pr-check', 'scripts/board', 'scripts/models', 'scripts/pr-video']) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  fs.cpSync(path.join(source, '.github/agents'), path.join(repo, '.github/agents'), { recursive: true });
  const qeConfig = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/qe/config.json'), 'utf8'));
  qeConfig.precheck.runTests = false;
  write(repo, 'scripts/qe/config.json', JSON.stringify(qeConfig, null, 2));
  const implConfig = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/implement/config.json'), 'utf8'));
  implConfig.implement.qePollSec = 0.1;
  implConfig.implement.parallel = 1; // the scripted agent answers in call order: one story at a time
  // This test covers the single-agent path; the orchestrated one is in orchestrate-e2e.test.mjs.
  implConfig.implement.orchestrate = false;
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
  // The stories are board tickets in the checkout's ticket cache (as `board fetch` leaves them).
  seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-apply-coupon', text: `# DEMO-1 Apply coupon\n\n${rule}` });
  seedTicket(repo, { key: 'DEMO-2', slug: 'DEMO-2-coupon-history', text: `# DEMO-2 Coupon history\n\n* **Blocked by:** [DEMO-1](DEMO-1-apply-coupon.md)\n\n${rule}` });
  seedTicket(repo, { key: 'DEMO-3', slug: 'DEMO-3-loyalty', text: `# DEMO-3 Loyalty\n\n${rule}` });
  seedTicket(repo, { key: 'DEMO-4', slug: 'DEMO-4-loyalty-tiers', text: `# DEMO-4 Loyalty tiers\n\n* **Blocked by:** [DEMO-3](DEMO-3-loyalty.md)\n\n${rule}` });
  incoming = ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4'];
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

  const dry = pipeline(['implement', 'run', ...incoming, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /1\. DEMO-1 +feat\/demo-1-apply-coupon <- main\n 2\. DEMO-2 +feat\/demo-2-coupon-history <- feat\/demo-1-apply-coupon {2}\(blocked by DEMO-1\)/);
  assert.ok(!fs.existsSync(`${scriptFile}.calls.json`), 'a dry run starts no agents');

  const result = pipeline(['implement', 'run', ...incoming]);
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
  ]);
  assert.ok(fs.existsSync(path.join(wt1, CACHE, 'DEMO-1/story.md')), "the ticket is in the worktree's cache, not on the branch");
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

  // The machine dies while DEMO-3 is being worked on: its runner never records an outcome.
  const runs = path.join(repo, '.agent-state/implement');
  const edit = (file, patch) => fs.writeFileSync(path.join(runs, file), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(runs, file), 'utf8')), ...patch }));
  edit('batch.json', { pid: 2 ** 22 + 7, finishedAt: null });
  edit('DEMO-3.json', { status: 'running', outcome: null });
  edit('DEMO-4.json', { findings: [{ issue: 'from an earlier attempt' }], agentRuns: 9 }); // DEMO-4 starts fresh, not resumed
  assert.match(pipeline(['implement', 'status']).stdout, /last implement run was interrupted.*implement resume/);
  assert.match(JSON.parse(pipeline(['hook', 'session-start']).stdout).additionalContext, /last implement run was interrupted[\s\S]*pipeline.mjs resume/, 'the next session is told');
  assert.match(pipeline(['implement', 'resume', 'DEMO-9', '--background']).stdout, /does not include DEMO-9/, 'a story-scoped resume leaves other batches alone');
  fs.writeFileSync(
    scriptFile,
    JSON.stringify({
      implementer: [{ writeImpl: 'src/Loyalty/Points.cs', result: { status: 'done', reason: 'points' } }],
      'architecture-reviewer': [{ result: { verdict: 'APPROVED', summary: 'ok', findings: [] } }],
      'qe-plan': [{ writePlan: happySad }],
      'qe-plan-verifier': [{ result: { score: 10, summary: 'ok', gaps: [] } }],
      'qe-automation': [{ writeTests: [1, 2], result: { status: 'done' } }],
      'qe-automation-verifier': [{ result: { score: 10, gaps: [] } }],
    }),
  );
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  const resumed = pipeline(['implement', 'resume']);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /DEMO-1 +skip: done in a previous run[\s\S]*DEMO-3 +feat\/demo-3-loyalty <- main {2}\(resume\)[\s\S]*DEMO-4 +feat\/demo-4-loyalty-tiers <- feat\/demo-3-loyalty/);
  assert.match(resumed.stdout, /DEMO-3 +done[\s\S]*DEMO-4 +done/);
  assert.equal(calls().implementer, 2, 'only the unfinished stories run again');
  const demo4 = JSON.parse(fs.readFileSync(path.join(runs, 'DEMO-4.json'), 'utf8'));
  assert.ok(!demo4.findings && demo4.agentRuns === undefined, "a fresh start drops the earlier attempt's findings and metrics");
  assert.match(prompts(), /=== implementer #1[\s\S]*previous run of this story was interrupted/);
  assert.match(pipeline(['implement', 'resume']).stdout, /DEMO-4 +skip: done in a previous run/, 'a finished run resumes to nothing');
  assert.match(pipeline(['resume']).stdout, /\[implement\]\nNo interrupted implement run\./);
});

test('implement run --epic: epic delivery by default (one epic branch), --delivery story keeps a branch per story; --dry-run starts nothing', () => {
  seedTicket(repo, { key: 'epic-promos', type: 'epic', text: '# Epic: Promos\n' });
  seedTicket(repo, { key: 'DEMO-7', slug: 'DEMO-7-banner', parent: 'epic-promos', text: '# DEMO-7 Banner\n\nRule.\n' });
  seedTicket(repo, { key: 'DEMO-8', slug: 'DEMO-8-promo-page', parent: 'epic-promos', text: '# DEMO-8 Promo page\n\n* **Blocked by:** [DEMO-7](DEMO-7-banner.md)\n\nRule.\n' });
  const epic = pipeline(['implement', 'run', '--epic', 'promos', '--dry-run', '--parallel', '1']);
  assert.equal(epic.status, 0, epic.stderr);
  assert.match(epic.stdout, /Delivery: epic\. One branch epic\/promos and one PR for epic-promos\./);
  assert.match(epic.stdout, /2\. DEMO-8 +feat\/demo-8-promo-page <- the epic's branch {2}\(blocked by DEMO-7\)/);
  const perStory = pipeline(['implement', 'run', '--epic', 'promos', '--delivery', 'story', '--dry-run', '--parallel', '1']);
  assert.equal(perStory.status, 0, perStory.stderr);
  assert.match(perStory.stdout, /2\. DEMO-8 +feat\/demo-8-promo-page <- feat\/demo-7-banner/);
  assert.equal(pipeline(['implement', 'run', '--epic', 'promos', '--delivery', 'nope', '--dry-run']).status, 2);
});

test('implement run --epic on a bug epic: the dry run names group delivery, not the epic branch', () => {
  seedTicket(repo, { key: 'epic-fixes', type: 'epic', text: '# Epic: Fixes\n' });
  seedTicket(repo, { key: 'BUG-71', slug: 'BUG-71-paging', type: 'bug', parent: 'epic-fixes', text: '# BUG-71 Paging\n\nRule.\n' });
  seedTicket(repo, { key: 'BUG-72', slug: 'BUG-72-auth', type: 'bug', parent: 'epic-fixes', text: '# BUG-72 Auth\n\nRule.\n' });
  const r = pipeline(['implement', 'run', '--epic', 'fixes', '--dry-run', '--parallel', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Delivery: bug groups\. Bug epic: the orchestrator groups the tickets into PRs\./);
  assert.match(r.stdout, /BUG-71 +feat\/bug-71-paging <- its group branch/);
  assert.doesNotMatch(r.stdout, /the epic's branch/);
});
