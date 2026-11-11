// Delivery experiments: every record tagged, board and lessons off, arms in their own branches from one
// base, the shared grading step, and the report's math. The arms' implement runs are faked in-process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { seedTicket } from './fixtures/tickets.mjs';
import { loadConfig } from '../lib/config.mjs';
import { decisionRecord } from '../lib/decisions.mjs';
import { armEnv, bucketOf, experimentReport, formatReport, loadExperiment, parseLog, pooledName, reworkRate, runExperiment, summarizeArm } from '../lib/experiment.mjs';
import { boardDisabled, lessonsDisabled, runTags } from '../lib/run-tags.mjs';
import { resetTicketMemo } from '../lib/tickets.mjs';
import { usageRecords } from '../lib/usage.mjs';
import { board } from '../../implement/lib/board-events.mjs';
import { lessonsCommand } from '../../qe/lib/lessons.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

test('run tags: usage and decision records carry experiment_id, experiment_arm and delivery only when set', async () => {
  const config = { root: os.tmpdir(), metricsDir: '.agent-metrics' };
  const plain = usageRecords(config, { ctx: { story: null, stage: 'implement' }, agent: 'implementer', mode: 'implement', cli: 'claude', runId: 'r1' })[0];
  assert.equal('experiment_id' in plain, false);
  await withEnv({ PIPELINE_EXPERIMENT_ID: 'x1', PIPELINE_EXPERIMENT_ARM: 'epic-1', PIPELINE_DELIVERY: 'epic' }, () => {
    const r = usageRecords(config, { ctx: { story: null, stage: 'implement' }, agent: 'implementer', mode: 'implement', cli: 'claude', runId: 'r2' })[0];
    assert.deepEqual([r.experiment_id, r.experiment_arm, r.delivery], ['x1', 'epic-1', 'epic']);
    const d = decisionRecord({ stage: 'review', story: 'A-1', agent: 'a', subject: 'b', decision: 'approved' });
    assert.deepEqual([d.experiment_id, d.delivery], ['x1', 'epic']);
    assert.deepEqual(runTags(), { delivery: 'epic', experiment_id: 'x1', experiment_arm: 'epic-1' });
  });
});

test('board and lessons are off in an experiment: board events spawn nothing, lessons write nothing', async () => {
  assert.equal(boardDisabled({ PIPELINE_BOARD: 'off' }), true);
  assert.equal(boardDisabled({ PIPELINE_BOARD: '0' }), true);
  assert.equal(boardDisabled({}), false);
  assert.equal(lessonsDisabled({ PIPELINE_LESSONS: 'off' }), true);
  await withEnv({ PIPELINE_BOARD: 'off', PIPELINE_LESSONS: 'off' }, async () => {
    const r = board('/nonexistent', ['claim', 'A-1']);
    assert.equal(r.skipped, true);
    const res = await lessonsCommand({ root: '/nonexistent', stateDir: '.agent-state' });
    assert.equal(res.status, 'disabled');
  });
  const env = armEnv({ id: 'x1' }, { name: 'story-1', mode: 'story', worktree: '/w', prefix: 'exp/x1/story-1/' }, {});
  assert.deepEqual([env.PIPELINE_BOARD, env.PIPELINE_LESSONS, env.PIPELINE_NO_PR, env.IMPLEMENT_BRANCH_PREFIX, env.PIPELINE_DELIVERY], ['off', 'off', '1', 'exp/x1/story-1/feat-', 'story']);
});

test('reworkRate, parseLog, bucketOf, pooledName', () => {
  const commits = parseLog('@@A-1: Implementation\nA\tsrc/a.cs\nA\tsrc/b.cs\n@@A-2: Implementation\nM\tsrc/a.cs\nA\tsrc/c.cs\n@@A-1: fix\nM\tsrc/b.cs\n@@experiment: merge\nM\tsrc/c.cs\n');
  assert.deepEqual(reworkRate(commits), { created: 3, reworked: 1, rate: 0.333 });
  assert.equal(bucketOf({ stage: 'implement', step: 'plan' }), 'overhead');
  assert.equal(bucketOf({ stage: 'implement', step: 'api' }), 'implement');
  assert.equal(bucketOf({ stage: 'implement-pair' }), 'implement');
  assert.equal(bucketOf({ stage: 'implement-verify' }), 'verify');
  assert.equal(bucketOf({ stage: 'review' }), 'overhead');
  assert.equal(bucketOf({ stage: 'implement-epic-plan' }), 'overhead');
  assert.equal(pooledName('e2e/teststack/epic.spec.ts', 'epic-1'), 'e2e/teststack/epic.from-epic-1.spec.ts');
});

test('summarizeArm: cost, tokens, premium requests, overhead share, implement-run sums and decision labels', () => {
  const u = (stage, step, input, cost) => ({ run_id: `${stage}-${step}-${input}`, stage, step, measured: true, tokens: { input, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, cost_usd: cost, premium_requests: 1 });
  const records = {
    'token-usage.jsonl': [u('implement', 'plan', 100, 1), u('implement-pair', 'api', 600, 2), u('implement-verify', 'api', 100, 0.5), u('review', null, 200, 0.5)],
    'implement-runs.jsonl': [{ outcome: 'done', pair_rounds: 2, escalations: 1, bug_fix_cycles: 0 }, { outcome: 'pair-exhausted', pair_rounds: 3, escalations: 1, bug_fix_cycles: 1 }],
    'decisions.jsonl': [],
    'subtask-runs.jsonl': [],
    'decision-outcomes.jsonl': [{ type: 'pr-group', groupId: 'g', tickets: ['A-1', 'A-2'], verified: 1 }],
  };
  const s = summarizeArm({ name: 'epic-1', mode: 'epic', wallClockSec: 600, grade: { passed: 3, total: 4, upheld: 2 } }, records, parseLog('@@A-1: x\nA\tf\n@@A-2: y\nM\tf\n'));
  assert.equal(s.costUsd, 4);
  assert.equal(s.tokens, 1000);
  assert.equal(s.premiumRequests, 4);
  assert.equal(s.agentRuns, 4);
  assert.deepEqual(s.tokensByBucket, { implement: 600, verify: 100, overhead: 300 });
  assert.equal(s.overheadShare, 0.3);
  assert.deepEqual([s.stories, s.done, s.pairRounds, s.escalations, s.bugFixCycles], [2, 1, 5, 2, 1]);
  assert.equal(s.rework.rate, 1);
  assert.deepEqual(s.sharedTests, { passed: 3, total: 4, rate: 0.75 });
  assert.equal(s.upheldFindings, 2);
  assert.deepEqual(s.decisionLabels, { 'bad-grouping': 1 });
});

test('experiment run: arms from one base on their own branches, results integrated, pooled tests graded on every arm, report per arm', async () => {
  resetTicketMemo();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-')));
  const repo = path.join(tmp, 'shop');
  write(repo, '.gitignore', '.agent-state/\n');
  write(repo, 'src/Base.cs', '// base\n');
  seedTicket(repo, { key: 'epic-shop', type: 'epic', text: '# Epic: Shop\n' });
  seedTicket(repo, { key: 'DEMO-1', parent: 'epic-shop', text: '# DEMO-1: A\n' });
  seedTicket(repo, { key: 'DEMO-2', parent: 'epic-shop', text: '# DEMO-2: B\n\n* **Blocked by:** DEMO-1\n' });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  const config = { ...loadConfig('implement', repo), baseRef: 'main' };
  const seen = [];
  // A fake arm: what `implement run` would leave behind for its delivery mode.
  const runArm = async (cfg, exp, arm) => {
    const env = armEnv(exp, arm, {});
    seen.push({ arm: arm.name, env, ticket: fs.existsSync(path.join(arm.worktree, '.agent-state/board/DEMO-1/story.md')) });
    const usage = (stage, input) => JSON.stringify({ run_id: `${arm.name}-${stage}`, stage, measured: true, tokens: { input, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, cost_usd: input / 100, experiment_id: exp.id, experiment_arm: arm.name, delivery: arm.mode });
    const commit = (wt, msg, files) => {
      for (const [f, t] of Object.entries(files)) write(wt, f, t);
      git(wt, 'add', '-A');
      git(wt, 'commit', '-qm', msg);
    };
    if (arm.mode === 'epic') {
      const branch = `${env.IMPLEMENT_EPIC_BRANCH_PREFIX}shop`;
      const wt = `${arm.worktree}-epic`;
      git(arm.worktree, 'worktree', 'add', '-q', '-b', branch, wt, arm.branch);
      commit(wt, 'DEMO-1: Implementation', { 'src/A.cs': 'a\n' });
      commit(wt, 'DEMO-2: Implementation', { 'src/B.cs': 'b\n' });
      commit(wt, 'EPIC-10: Add verified epic test plan and automated tests', { 'e2e/teststack/epic.spec.ts': "test('TC-EPIC-10-01 journey', PASS)\n", '.agent-metrics/token-usage.jsonl': `${usage('implement-pair', 600)}\n${usage('review', 400)}\n`, '.agent-metrics/implement-runs.jsonl': `${JSON.stringify({ story: 'DEMO-1', outcome: 'done', pair_rounds: 1, experiment_id: exp.id, experiment_arm: arm.name })}\n` });
      write(arm.worktree, '.agent-state/implement/epics/epic-shop.json', JSON.stringify({ epic: 'epic-shop', units: { epic: { branch } } }));
    } else {
      for (const [key, file, extra] of [['DEMO-1', 'src/A.cs', {}], ['DEMO-2', 'src/A.cs', { 'src/B.cs': 'b\n' }]]) {
        const branch = `${env.IMPLEMENT_BRANCH_PREFIX}${key.toLowerCase()}`;
        const wt = `${arm.worktree}-${key}`;
        git(arm.worktree, 'worktree', 'add', '-q', '-b', branch, wt, key === 'DEMO-1' ? arm.branch : `${env.IMPLEMENT_BRANCH_PREFIX}demo-1`);
        commit(wt, `${key}: Implementation`, { [file]: `${key}\n`, ...extra, '.agent-metrics/token-usage.jsonl': `${usage(`implement-${key}`, 300)}\n` });
        write(arm.worktree, `.agent-state/implement/${key}.json`, JSON.stringify({ key, outcome: 'done', branch }));
      }
    }
    return { code: 0 };
  };
  const ran = [];
  const exp = await runExperiment(config, {
    epic: 'shop',
    modes: ['epic', 'story'],
    repeat: 1,
    sequential: true,
    deps: {
      runArm,
      runTest: async (cfg, arm, file) => {
        ran.push([arm.name, file]);
        return fs.readFileSync(path.join(arm.worktree, file), 'utf8').includes('PASS') && fs.existsSync(path.join(arm.worktree, 'src/B.cs'));
      },
      prCheck: async (cfg, arm) => ({ verdict: 'FAIL', score: 8, upheld: arm.mode === 'story' ? 2 : 1 }),
    },
  });
  assert.deepEqual(exp.arms.map((a) => a.branch), [`exp/${exp.id}-epic-1`, `exp/${exp.id}-story-1`]);
  assert.ok(seen.every((s) => s.ticket), 'the tickets are copied into every arm');
  assert.ok(seen.every((s) => s.env.PIPELINE_EXPERIMENT_ID === exp.id && s.env.PIPELINE_BOARD === 'off'));
  for (const a of exp.arms) assert.equal(git(repo, 'merge-base', a.branch, 'main'), git(repo, 'rev-parse', 'main'), 'every arm starts from the same base');
  assert.deepEqual(exp.arms.map((a) => a.integration.merged.length), [1, 2]);
  // The epic arm's journey spec is pooled and run against both arms (renamed in the story arm).
  assert.deepEqual(ran, [['epic-1', 'e2e/teststack/epic.spec.ts'], ['story-1', 'e2e/teststack/epic.from-epic-1.spec.ts']]);
  assert.ok(!fs.existsSync(path.join(exp.arms[1].worktree, 'e2e/teststack/epic.from-epic-1.spec.ts')), 'pooled copies are removed after grading');
  assert.equal(loadExperiment(config, exp.id).arms[1].grade.passed, 1);

  const rep = experimentReport(config, exp.id);
  const [epicArm, storyArm] = rep.arms;
  assert.equal(epicArm.tokens, 1000);
  assert.equal(epicArm.overheadShare, 0.4);
  assert.equal(epicArm.costUsd, 10);
  assert.equal(storyArm.tokens, 600);
  assert.equal(storyArm.rework.reworked, 1, 'DEMO-2 modified the file DEMO-1 created');
  assert.equal(epicArm.rework.reworked, 0);
  assert.deepEqual([epicArm.upheldFindings, storyArm.upheldFindings], [1, 2]);
  assert.match(formatReport(rep), /Caveats:[\s\S]*n is small/);
});
