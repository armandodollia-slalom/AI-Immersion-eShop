// `pipeline implement requeue` (lib/requeue.mjs) with fake board and implement runners, and the launchd
// plist of requeue-schedule.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { batchesFor, blockedReason, lastRequeue, requeue } from '../lib/requeue.mjs';
import { renderPlist } from '../requeue-schedule.mjs';

function env({ resolved = [], requeued = resolved, tickets = {}, epicRuns = {}, exit = () => 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-'));
  const config = { root, stateDir: '.agent-state', implement: {} };
  const calls = { board: [], runs: [], logs: [] };
  const deps = {
    log: (m) => calls.logs.push(m),
    board: (args) => {
      calls.board.push(args);
      return { status: 0, stdout: `Board synced.\n${JSON.stringify({ resolved, requeued: args[0] === 'sync' ? requeued : [] })}\n` };
    },
    ticketOf: (key) => tickets[key] ?? { key, epic: null },
    epicRunOf: (epic) => epicRuns[epic] ?? null,
    runImplement: async (args) => {
      calls.runs.push(args);
      return exit(args);
    },
  };
  const runs = path.join(root, '.agent-state', 'implement');
  fs.mkdirSync(runs, { recursive: true });
  return { root, config, deps, calls, runs, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('nothing resolved: a no-op that exits 0 and starts nothing', async () => {
  const e = env();
  try {
    const r = await requeue(e.config, {}, e.deps);
    assert.deepEqual([r.status, r.exit], ['nothing', 0]);
    assert.deepEqual(e.calls.board, [['sync', '--json']]);
    assert.deepEqual(e.calls.runs, []);
    assert.equal(lastRequeue(e.config).last.status, 'nothing');
  } finally {
    e.cleanup();
  }
});

test('several resolved tickets run in one batch with the usual flags', async () => {
  const e = env({ resolved: ['BUG-1', 'BUG-3', 'PROMO-2'] });
  try {
    const r = await requeue(e.config, {}, e.deps);
    assert.equal(r.status, 'ran');
    assert.deepEqual(e.calls.runs, [['run', 'BUG-1', 'BUG-3', 'PROMO-2', '--parallel', 'auto', '--pr']]);
    assert.ok(e.calls.logs.some((l) => /Moved to Ready: BUG-1, BUG-3, PROMO-2/.test(l)));
    assert.equal(fs.existsSync(path.join(e.runs, 'requeue.lock')), false, 'the lock is released');
  } finally {
    e.cleanup();
  }
});

test('tickets of an epic run in progress go per delivery unit, so bug-epic PR groups still work', () => {
  const epicRuns = { 'epic-64': { status: 'running', units: { g1: { id: 'g1', keys: ['BUG-1', 'BUG-2'], branch: 'fix/g1' }, g2: { id: 'g2', keys: ['BUG-5'], branch: 'fix/g2' } } }, 'epic-9': { status: 'done', units: { a: { id: 'a', keys: ['BUG-9'] } } } };
  const tickets = { 'BUG-1': { epic: 'epic-64' }, 'BUG-2': { epic: 'epic-64' }, 'BUG-5': { epic: 'epic-64' }, 'BUG-9': { epic: 'epic-9' }, 'PROMO-2': { epic: null } };
  const batches = batchesFor(['BUG-1', 'BUG-2', 'BUG-5', 'BUG-9', 'PROMO-2'], { ticketOf: (k) => tickets[k], epicRunOf: (k) => epicRuns[k] });
  assert.deepEqual(
    batches.map((b) => [b.epic, b.unit, b.keys]),
    [
      [null, null, ['BUG-9', 'PROMO-2']],
      ['epic-64', 'g1', ['BUG-1', 'BUG-2']],
      ['epic-64', 'g2', ['BUG-5']],
    ],
  );
});

test('an active, interrupted or outage-stopped implement run here: skipped without touching the board', async () => {
  const e = env({ resolved: ['BUG-1'] });
  try {
    fs.writeFileSync(path.join(e.runs, 'batch.json'), JSON.stringify({ pid: process.pid, startedAt: 'now', finishedAt: null }));
    let r = await requeue(e.config, {}, e.deps);
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /an implement run is active/);
    assert.deepEqual([e.calls.board, e.calls.runs], [[], []]);

    fs.writeFileSync(path.join(e.runs, 'batch.json'), JSON.stringify({ pid: 999999, startedAt: 'then', finishedAt: null }));
    assert.match(blockedReason(e.config), /interrupted; continue it with `pipeline implement resume`/);

    fs.writeFileSync(path.join(e.runs, 'batch.json'), JSON.stringify({ pid: 999999, finishedAt: '2026-11-11T00:00:00Z' }));
    fs.writeFileSync(path.join(e.runs, 'agent-outage.json'), JSON.stringify({ cli: 'claude', reason: 'usage limit', at: new Date().toISOString() }));
    r = await requeue(e.config, {}, e.deps);
    assert.match(r.reason, /agent provider is unavailable \(claude: usage limit/);
    fs.writeFileSync(path.join(e.runs, 'agent-outage.json'), JSON.stringify({ cli: 'claude', reason: 'usage limit', at: '2020-01-01T00:00:00Z' }));
    assert.equal(blockedReason(e.config), null, 'an old outage no longer blocks');
  } finally {
    e.cleanup();
  }
});

test('a run stopped by a provider outage (exit 75) starts no further batch', async () => {
  const tickets = { 'BUG-1': { epic: 'epic-64' } };
  const epicRuns = { 'epic-64': { status: 'running', units: { g1: { id: 'g1', keys: ['BUG-1'] } } } };
  const e = env({ resolved: ['PROMO-2', 'BUG-1'], tickets, epicRuns, exit: () => 75 });
  try {
    const r = await requeue(e.config, {}, e.deps);
    assert.equal(r.exit, 75);
    assert.equal(e.calls.runs.length, 1);
  } finally {
    e.cleanup();
  }
});

test('--requeue-only moves the cards and starts nothing; --dry-run only lists', async () => {
  const e = env({ resolved: ['BUG-1', 'BUG-2'] });
  try {
    const r = await requeue(e.config, { requeueOnly: true }, e.deps);
    assert.deepEqual([r.status, r.keys], ['requeued', ['BUG-1', 'BUG-2']]);
    assert.deepEqual(e.calls.board, [['sync', '--json']]);
    assert.deepEqual(e.calls.runs, []);
    assert.ok(e.calls.logs.some((l) => l === 'Would run: implement run BUG-1 BUG-2 --parallel auto --pr'));

    e.calls.board.length = 0;
    fs.rmSync(path.join(e.runs, 'requeue-last.json'));
    const d = await requeue(e.config, { dryRun: true, parallel: 2, pr: false }, e.deps);
    assert.equal(d.status, 'dry-run');
    assert.deepEqual(e.calls.board, [['resolved', '--json']], 'a dry run moves no card');
    assert.deepEqual(e.calls.runs, []);
    assert.ok(e.calls.logs.some((l) => l === 'Would run: implement run BUG-1 BUG-2 --parallel 2'));
    assert.equal(lastRequeue(e.config).last, null, 'a dry run records nothing');
  } finally {
    e.cleanup();
  }
});

test('the launchd plist runs implement requeue from the main checkout on the interval, with the given env', () => {
  const plist = renderPlist({ node: '/usr/local/bin/node', checkout: '/Users/me/code/shop', intervalMin: 30, env: { PATH: '/a:/b', PIPELINE_AGENT_CLI: 'claude', EMPTY: '' }, logFile: '/Users/me/code/shop/.agent-state/logs/requeue-launchd.log' });
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/Users\/me\/code\/shop\/scripts\/pipeline\/pipeline\.mjs<\/string>\s*<string>implement<\/string>\s*<string>requeue<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>1800<\/integer>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/me\/code\/shop<\/string>/);
  assert.match(plist, /<key>PIPELINE_AGENT_CLI<\/key>\s*<string>claude<\/string>/);
  assert.doesNotMatch(plist, /EMPTY/);
});
