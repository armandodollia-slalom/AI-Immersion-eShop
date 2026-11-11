// Epic delivery against a real throwaway git repo, with the story workers, agents, QE, PR check, PR and
// board faked in-process: the epic plan and its note reaching the story orchestrators, merges into the
// epic branch in Blocked-by order, one PR with every Closes line, partial failure, cross-story owns
// serialization, joining an in-progress epic, and bug epics delivered as PR groups.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';
import { loadConfig } from '../../pipeline/lib/config.mjs';
import { loadTicket, resetTicketMemo } from '../../pipeline/lib/tickets.mjs';
import { readJsonl } from '../../pipeline/lib/util.mjs';
import { epicToJoin, loadEpicRun, runEpic } from '../lib/epic.mjs';
import { deliveryShape, epicDeps, epicPrBody, groupDeps, nextStories, ownsConflict, singleGroups, validateGroups, validateNote } from '../lib/epic-plan.mjs';
import { groupRow, labelDecisions } from '../lib/decisions.mjs';
import { planTask } from '../lib/tasks.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = (o) => `Planned.\nAGENT_RESULT: ${JSON.stringify(o)}\n`;

const story = (key, title, blockers = []) => `# ${key}: ${title}\n\n${blockers.length ? `* **Blocked by:** ${blockers.join(', ')}\n\n` : ''}**Acceptance Criteria:**\n\n- it works\n`;

function makeRepo({ bugs = false } = {}) {
  resetTicketMemo();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'epic-')));
  const repo = path.join(tmp, 'shop');
  write(repo, 'src/Shared/Common.cs', '// shared\n');
  write(repo, '.gitignore', '.agent-state/\nartifacts/\n');
  seedTicket(repo, { key: 'epic-shop', type: 'epic', text: '# Epic: Shop\n\nThe shop epic.\n', number: 10 });
  if (bugs) {
    seedTicket(repo, { key: 'BUG-1', type: 'bug', parent: 'epic-shop', number: 21, text: story('BUG-1', 'Cart total wrong') });
    seedTicket(repo, { key: 'BUG-2', type: 'bug', parent: 'epic-shop', number: 22, text: story('BUG-2', 'Cart rounding', ['BUG-1']) });
    seedTicket(repo, { key: 'BUG-3', type: 'bug', parent: 'epic-shop', number: 23, text: story('BUG-3', 'Login redirect') });
  } else {
    seedTicket(repo, { key: 'DEMO-1', parent: 'epic-shop', number: 11, text: story('DEMO-1', 'Catalog') });
    seedTicket(repo, { key: 'DEMO-2', parent: 'epic-shop', number: 12, text: story('DEMO-2', 'Basket', ['DEMO-1']) });
    seedTicket(repo, { key: 'DEMO-3', parent: 'epic-shop', number: 13, text: story('DEMO-3', 'Ordering') });
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  const base = loadConfig('implement', repo);
  const config = { ...base, agent: { ...base.agent, cmd: null, cli: 'claude', models: { default: null, implementer: null } }, implement: { ...base.implement, checks: [], unitTests: null, prepareCmd: null, lsp: { enabled: false }, epic: { ...base.implement.epic } } };
  const keys = bugs ? ['BUG-1', 'BUG-2', 'BUG-3'] : ['DEMO-1', 'DEMO-2', 'DEMO-3'];
  const tickets = keys.map((k) => loadTicket(config, k, { fetch: false }));
  const epicT = loadTicket(config, 'epic-shop', { fetch: false });
  const epic = { ...epicT, number: 10, url: 'https://github.com/example/repo/issues/10' };
  return { tmp, repo, config, tickets, epic, inputs: tickets.map((t) => config.abs(t.file)) };
}

const fakeLsp = () => ({ start: async () => ({}), stop: async () => {}, stopAll: async () => {}, diagnostics: async () => ({ available: false, errors: [], warnings: [] }), calls: () => [], isReferences: () => false, csharpRunning: () => false });

// A story worker that implements the story on its branch (from the base it was given) and reports an
// outcome. `outcomes` overrides per key; `files` sets the file each story writes.
function fakeWorker({ outcomes = {}, files = {}, delay = 20 } = {}) {
  const calls = [];
  let running = 0;
  const peak = { n: 0, overlap: [] };
  const live = new Set();
  const startWorker = async (config, s) => {
    calls.push({ key: s.key, base: s.base, branch: s.branch, epicNote: s.epicNote, epicBranch: s.epicBranch, note: s.epicNote ? fs.readFileSync(s.epicNote, 'utf8') : null });
    running++;
    live.add(s.key);
    peak.n = Math.max(peak.n, running);
    peak.overlap.push([...live]);
    try {
      git(config.root, 'worktree', 'add', '-q', '-b', s.branch, s.worktree, s.base);
      write(s.worktree, files[s.key] ?? `src/${s.key}.cs`, `// ${s.key}\n`);
      git(s.worktree, 'add', '-A');
      git(s.worktree, 'commit', '-qm', `${s.key}: Implementation`);
      await sleep(delay);
      return { key: s.key, outcome: outcomes[s.key] ?? 'done', reason: outcomes[s.key] ? 'nope' : null, branch: s.branch, worktree: s.worktree, mode: 'self', agentRuns: 3, cost_usd: 1.5 };
    } finally {
      running--;
      live.delete(s.key);
    }
  };
  return { startWorker, calls, peak };
}

function fakeDeps(note, extra = {}) {
  const board = [];
  const prs = [];
  const agentCalls = [];
  const checks = [];
  const gates = [];
  const deps = {
    runAgent: async (config, opts) => {
      agentCalls.push(opts);
      const out = typeof note === 'function' ? note(agentCalls.length, opts) : note;
      return { ok: true, status: 0, output: result(out), version: 'v1' };
    },
    lsp: fakeLsp(),
    board: (root, key, args) => board.push([key, ...args]),
    epicQe: async (env, { key }) => ({ status: 'verified', key }),
    prCheck: async (env, keys) => (checks.push(keys), { verdict: 'PASS', score: 10, openFindings: [] }),
    openPr: (env, { title, body }) => {
      prs.push({ title, body, branch: env.branch, base: env.prBase });
      return { url: `https://github.com/example/repo/pull/${100 + prs.length}` };
    },
    reviewGate: (env, { pr, keys }) => gates.push({ pr, keys, worktree: env.worktree, base: env.prBase }),
    ...extra,
  };
  return { deps, board, prs, agentCalls, checks, gates };
}

const featureNote = {
  summary: 'Catalog feeds the basket; ordering is separate.',
  contracts: [{ name: 'GET /api/catalog/items', kind: 'api', definition: 'items[]', owner: 'DEMO-1', usedBy: ['DEMO-2'] }],
  stories: [
    { key: 'DEMO-1', owns: ['src/DEMO-1.cs'] },
    { key: 'DEMO-2', owns: ['src/DEMO-2.cs'] },
    { key: 'DEMO-3', owns: ['src/DEMO-3.cs'] },
  ],
  buildOrder: ['DEMO-1', 'DEMO-2', 'DEMO-3'],
  journeys: [{ id: 'browse-to-basket', title: 'Browse then add to basket', stories: ['DEMO-1', 'DEMO-2'], steps: ['open catalog', 'add item'], expected: 'basket shows the item' }],
};

// ---------------------------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------------------------

test('validateNote: normalizes the note, rejects unknown keys, bad journeys and dependency cycles', () => {
  const ok = validateNote(featureNote, { keys: ['DEMO-1', 'DEMO-2', 'DEMO-3'] });
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  assert.deepEqual(ok.note.stories.map((s) => s.key), ['DEMO-1', 'DEMO-2', 'DEMO-3']);
  const bad = validateNote({ stories: [{ key: 'X-9' }, { key: 'DEMO-1', dependsOn: ['DEMO-2'] }, { key: 'DEMO-2', dependsOn: ['DEMO-1'] }], journeys: [{ id: 'Bad Id', stories: ['NOPE-1'] }], foundation: { goal: 'x', owns: [] } }, { keys: ['DEMO-1', 'DEMO-2'] });
  assert.equal(bad.ok, false);
  for (const re of [/X-9/, /cycle/, /Bad Id/, /NOPE-1/, /foundation.owns/]) assert.ok(bad.errors.some((e) => re.test(e)), `${re} in ${bad.errors.join('; ')}`);
  assert.match(validateNote(null, { keys: [] }).errors[0], /AGENT_RESULT/);
});

test('validateGroups: coverage, duplicates, Blocked-by order; no cap by default, a configured cap is enforced', () => {
  const stories = [{ key: 'BUG-1', blockedBy: [] }, { key: 'BUG-2', blockedBy: ['BUG-1'] }, { key: 'BUG-3', blockedBy: [] }];
  const one = [{ id: 'all', tickets: ['BUG-1', 'BUG-2', 'BUG-3'] }];
  assert.equal(validateGroups(one, { stories }).ok, true, 'no cap by default');
  assert.equal(validateGroups(one, { stories, maxPerGroup: 0 }).ok, true, '0 means no cap');
  assert.match(validateGroups(one, { stories, maxPerGroup: 2 }).errors.join(), /more than maxBugsPerGroup \(2\)/);
  const errors = validateGroups([{ id: 'b', tickets: ['BUG-2', 'BUG-3'] }, { id: 'a', tickets: ['BUG-1', 'BUG-3'] }], { stories }).errors.join('\n');
  assert.match(errors, /BUG-3 is in both b and a/);
  assert.match(errors, /BUG-2 is blocked by BUG-1, which is in the later group a/);
  assert.match(validateGroups([{ id: 'a', tickets: ['BUG-1'] }], { stories }).errors.join(), /BUG-2 is in no group/);
  assert.deepEqual(Object.fromEntries(groupDeps([{ id: 'a', tickets: ['BUG-1'] }, { id: 'b', tickets: ['BUG-2', 'BUG-3'] }], stories)), { a: [], b: ['a'] });
});

test('deliveryShape: bug epics are grouped when most tickets are bugs; --grouping overrides', () => {
  const bug = (k) => ({ key: k, type: 'bug' });
  const st = (k) => ({ key: k, type: 'story' });
  assert.deepEqual(deliveryShape([bug('BUG-1'), bug('BUG-2'), st('X-1')]), { kind: 'groups', planned: true });
  assert.deepEqual(deliveryShape([bug('BUG-1'), st('X-1')]), { kind: 'epic' });
  assert.deepEqual(deliveryShape([st('X-1')], 'ticket'), { kind: 'groups', planned: false });
  assert.deepEqual(deliveryShape([bug('BUG-1')], 'epic'), { kind: 'epic' });
});

test('nextStories: dependencies merged first, overlapping owns never run together, failed blockers skip dependents', () => {
  const deps = epicDeps([{ key: 'A-1', blockedBy: [] }, { key: 'A-2', blockedBy: ['A-1'] }, { key: 'A-3', blockedBy: [] }, { key: 'A-4', blockedBy: [] }], { stories: [{ key: 'A-4', dependsOn: ['A-3'] }] });
  assert.deepEqual(deps.get('A-4'), ['A-3'], "the note's dependsOn adds ordering");
  const owns = new Map([['A-1', ['src/Catalog/**']], ['A-3', ['src/Catalog/Api.cs']], ['A-4', ['src/Ordering/**']]]);
  assert.ok(ownsConflict(owns.get('A-1'), owns.get('A-3')));
  const base = { order: ['A-1', 'A-2', 'A-3', 'A-4'], deps, owns, running: new Set(), merged: new Set(), failed: new Set(), slots: 4 };
  assert.deepEqual(nextStories({ ...base, pending: new Set(['A-1', 'A-2', 'A-3', 'A-4']) }).start, ['A-1'], 'A-3 overlaps A-1; A-2 and A-4 wait for their dependencies');
  assert.deepEqual(nextStories({ ...base, pending: new Set(['A-2', 'A-3', 'A-4']), running: new Set(), merged: new Set(['A-1']) }).start, ['A-2', 'A-3']);
  assert.deepEqual(nextStories({ ...base, pending: new Set(['A-2']), failed: new Set(['A-1']) }).skip, [{ key: 'A-2', blocker: 'A-1' }]);
});

test('epicPrBody: every story with Closes #N, the epic linked, per-story evidence; group PRs say why they are grouped', () => {
  const stories = [{ key: 'DEMO-1', number: 11, title: 'Catalog' }, { key: 'DEMO-2', number: 12, title: 'Basket' }];
  const body = epicPrBody({ epic: { key: 'epic-shop', number: 10, title: 'Shop', url: 'u' }, branch: 'epic/shop', stories, results: { 'DEMO-1': { outcome: 'done', mode: 'self', agentRuns: 3 } }, qe: { key: 'EPIC-10', status: 'verified' }, prChecks: { 'DEMO-1': { verdict: 'PASS', score: 10 } } });
  assert.match(body, /Closes #11\nCloses #12/);
  assert.match(body, /Part of #10/);
  assert.match(body, /DEMO-1 \(#11\): Catalog \| done \| self, 3 agent runs .* PASS 10\/10/);
  assert.match(body, /Cross-story journeys: .* verified \(`EPIC-10`\)/);
  const g = epicPrBody({ epic: { key: 'epic-shop', number: 10 }, branch: 'bugfix/shop/cart', stories, results: {}, group: { id: 'cart', title: 'Cart fixes', tickets: ['DEMO-1', 'DEMO-2'], reason: 'same service', risk: 'low' } });
  assert.match(g, /as one PR group, `cart`: Cart fixes/);
  assert.match(g, /Grouped because: same service \(risk: low\)/);
});

test("planTask carries the epic design note to the story orchestrator", () => {
  const task = planTask({ key: 'DEMO-2', storyFile: '/w/s.md', worktree: '/w', uiStory: false, limits: { maxSubtasks: 4, selfModeMaxFiles: 6, maxLargeSubtasks: 1 }, epicNote: '# Epic design note\n\nReuse CatalogItemDto.' });
  assert.match(task, /### Epic design note[\s\S]*Reuse CatalogItemDto/);
  assert.doesNotMatch(planTask({ key: 'X-1', storyFile: '/w/s.md', worktree: '/w', uiStory: false, limits: { maxSubtasks: 4, selfModeMaxFiles: 6, maxLargeSubtasks: 1 } }), /Epic design note/);
});

test('decisions: a PR group where one ticket failed and others verified is labeled bad-grouping', () => {
  assert.deepEqual(groupRow({ type: 'pr-group', epic: 'epic-shop', groupId: 'cart', tickets: ['BUG-1', 'BUG-2'], verified: 1 }).labels, ['bad-grouping']);
  assert.deepEqual(groupRow({ type: 'pr-group', groupId: 'auth', tickets: ['BUG-3'], verified: 1, pr: 'u' }).labels, []);
  const rows = labelDecisions({ outcomes: [{ type: 'pr-group', epic: 'e', groupId: 'g', tickets: ['A-1', 'A-2'], verified: 2, mergeConflicts: 1 }] });
  assert.deepEqual(rows[0].labels, ['bad-grouping'], 'merge conflicts inside a group count too');
});

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------

test('feature epic: plan note reaches every story, stories merge into the epic branch in Blocked-by order, one PR closes them all', async () => {
  const env = makeRepo();
  const worker = fakeWorker();
  const f = fakeDeps(featureNote, { startWorker: worker.startWorker });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 2, pr: true, deps: f.deps, log: () => {} });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r));
  assert.deepEqual(r.results.map((x) => [x.key, x.outcome]), [['DEMO-1', 'done'], ['DEMO-2', 'done'], ['DEMO-3', 'done']]);
  // Epic plan: one read-mode orchestrator run, logged as stage implement-epic-plan.
  assert.equal(f.agentCalls[0].mode, 'read');
  assert.match(f.agentCalls[0].task, /EPIC PLAN mode[\s\S]*### Story DEMO-2 \(blocked by DEMO-1\)/);
  const wt = path.join(env.tmp, 'shop-worktrees', 'epic-shop');
  const decisions = readJsonl(path.join(wt, '.agent-metrics/decisions.jsonl'));
  assert.ok(decisions.some((d) => d.stage === 'implement-epic-plan' && d.decision === 'plan-written'));
  // Every story got the note and branched from the epic branch.
  for (const c of worker.calls) {
    assert.equal(c.base, 'epic/shop');
    assert.equal(c.epicBranch, 'epic/shop');
    assert.match(c.note, /Catalog feeds the basket/);
  }
  const order = worker.calls.map((c) => c.key);
  assert.ok(order.indexOf('DEMO-1') < order.indexOf('DEMO-2'), 'DEMO-2 starts after DEMO-1 merged');
  const merges = git(wt, 'log', '--format=%s', '--merges', 'main..epic/shop').split('\n').reverse();
  assert.ok(merges.indexOf('DEMO-1: Merge into epic/shop') < merges.indexOf('DEMO-2: Merge into epic/shop'));
  assert.ok(fs.existsSync(path.join(wt, 'src/DEMO-2.cs')) && fs.existsSync(path.join(wt, 'src/DEMO-3.cs')));
  // One PR, every Closes line; board: review with the epic branch per story, then epic-pr.
  assert.deepEqual(f.checks, [['DEMO-1', 'DEMO-2', 'DEMO-3', 'EPIC-10']], 'one PR check over every story and the journeys');
  assert.equal(f.prs.length, 1);
  assert.equal(f.prs[0].title, 'Epic: Shop');
  assert.match(f.prs[0].body, /Closes #11\nCloses #12\nCloses #13/);
  for (const k of ['DEMO-1', 'DEMO-2', 'DEMO-3']) assert.ok(f.board.some((b) => b[0] === k && b[1] === 'review' && b.includes('--epic-branch') && b.includes('epic/shop')), `${k} review`);
  assert.ok(f.board.some((b) => b[1] === 'epic-pr' && b[2] === '10' && b.includes('https://github.com/example/repo/pull/101')));
  assert.equal(loadEpicRun(env.config, 'epic-shop').status, 'delivered');
  assert.deepEqual(f.gates, [], 'feature epic PRs are not gated');
});

test('feature epic: stories whose owns overlap never run at the same time', async () => {
  const env = makeRepo();
  const worker = fakeWorker({ delay: 60 });
  const note = { ...featureNote, stories: [{ key: 'DEMO-1', owns: ['src/**'] }, { key: 'DEMO-2', owns: ['src/DEMO-2.cs'] }, { key: 'DEMO-3', owns: ['src/DEMO-3.cs'] }] };
  const f = fakeDeps(note, { startWorker: worker.startWorker });
  await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 3, deps: f.deps, log: () => {} });
  assert.ok(worker.peak.overlap.every((live) => !(live.includes('DEMO-1') && live.includes('DEMO-3'))), JSON.stringify(worker.peak.overlap));
  assert.equal(worker.calls.length, 3);
});

test('feature epic: a failed story skips its dependents, independents still merge, no PR; a later single ticket joins the epic branch', async () => {
  const env = makeRepo();
  const worker = fakeWorker({ outcomes: { 'DEMO-1': 'pair-exhausted' } });
  const f = fakeDeps(featureNote, { startWorker: worker.startWorker });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 2, pr: true, deps: f.deps, log: () => {} });
  assert.deepEqual(Object.fromEntries(r.results.map((x) => [x.key, x.outcome])), { 'DEMO-1': 'pair-exhausted', 'DEMO-2': 'skipped', 'DEMO-3': 'done' });
  assert.match(r.results.find((x) => x.key === 'DEMO-2').reason, /^blocker DEMO-1 ended pair-exhausted/);
  assert.equal(f.prs.length, 0, 'no epic PR while a story failed');
  assert.equal(r.epic.outcome, 'stories-failed');
  const state = loadEpicRun(env.config, 'epic-shop');
  assert.equal(state.status, 'failed');
  assert.equal(state.stories['DEMO-3'].merged, true);

  // DEMO-1 is fixed and run on its own: it joins the epic branch (no PR), unless --standalone.
  const join = epicToJoin(env.config, [env.tickets[0]]);
  assert.equal(join.unit.branch, 'epic/shop');
  assert.equal(epicToJoin(env.config, [env.tickets[0]], { standalone: true }), null);
  git(env.repo, 'worktree', 'remove', '--force', path.join(env.tmp, 'shop-worktrees', 'demo-1'));
  git(env.repo, 'branch', '-D', worker.calls[0].branch);
  const again = fakeWorker();
  const f2 = fakeDeps(featureNote, { startWorker: again.startWorker });
  const j = await runEpic(env.config, { epic: env.epic, tickets: [env.tickets[0]], inputs: [env.inputs[0]], base: 'main', only: ['DEMO-1'], deps: f2.deps, log: () => {} });
  assert.equal(j.epic.outcome, 'joined');
  assert.deepEqual(again.calls.map((c) => [c.key, c.base]), [['DEMO-1', 'epic/shop']]);
  assert.equal(f2.agentCalls.length, 0, 'a joining ticket does not plan the epic again');
  assert.equal(f2.prs.length, 0);
  assert.equal(loadEpicRun(env.config, 'epic-shop').stories['DEMO-1'].merged, true);
});

test('bug epic: the orchestrator groups the bugs; each group gets its branch, its PR and its board evidence', async () => {
  const env = makeRepo({ bugs: true });
  const worker = fakeWorker();
  const note = { summary: 'two areas', stories: [], prGroups: [{ id: 'cart', title: 'Cart totals', tickets: ['BUG-1', 'BUG-2'], reason: 'same root cause', risk: 'low' }, { id: 'auth', title: 'Login', tickets: ['BUG-3'], reason: 'security fix ships alone', risk: 'high' }] };
  const f = fakeDeps(note, { startWorker: worker.startWorker });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 2, pr: true, deps: f.deps, log: () => {} });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  assert.match(f.agentCalls[0].task, /bug epic[\s\S]*prGroups/);
  assert.doesNotMatch(f.agentCalls[0].task, /at most \d+ tickets per group/, 'no cap by default');
  assert.deepEqual(f.prs.map((p) => p.branch).sort(), ['bugfix/shop/auth', 'bugfix/shop/cart']);
  const cart = f.prs.find((p) => p.branch === 'bugfix/shop/cart');
  assert.match(cart.body, /Closes #21\nCloses #22/);
  assert.doesNotMatch(cart.body, /#23/);
  assert.equal(worker.calls.find((c) => c.key === 'BUG-3').base, 'bugfix/shop/auth');
  // Cards go to Pending Review with their group's PR; the epic evidence lists each group PR.
  const cartUrl = `https://github.com/example/repo/pull/${101 + f.prs.indexOf(cart)}`;
  for (const k of ['BUG-1', 'BUG-2']) assert.ok(f.board.some((b) => b[0] === k && b[1] === 'review' && b.includes('--pr') && b.includes(cartUrl)), `${k} review with the group PR`);
  assert.equal(f.board.filter((b) => b[1] === 'epic-pr' && b.includes('--group')).length, 2);
  // Every published group PR goes through the review gate, from its group worktree.
  assert.deepEqual(f.gates.map((g) => [g.keys.join(','), g.pr === cartUrl, g.base]).sort(), [['BUG-1,BUG-2', true, 'main'], ['BUG-3', false, 'main']]);
  // Decision log and per-group outcomes in this checkout's metrics.
  const decisions = readJsonl(path.join(env.repo, '.agent-metrics/decisions.jsonl'));
  const grouping = decisions.find((d) => d.decision === 'pr-groups');
  assert.deepEqual(grouping.items.map((i) => i.id), ['cart', 'auth']);
  const outcomes = readJsonl(path.join(env.repo, '.agent-metrics/decision-outcomes.jsonl')).filter((o) => o.type === 'pr-group');
  assert.deepEqual(outcomes.map((o) => [o.groupId, o.verified, Boolean(o.pr), o.cost_usd]).sort(), [['auth', 1, true, 1.5], ['cart', 2, true, 3]]);
});

test('bug epic: a reopened ticket of a delivered group joins it again while its PR is open, pushes it and re-gates it', async () => {
  const env = makeRepo({ bugs: true });
  const origin = path.join(env.tmp, 'origin.git');
  git(env.tmp, 'init', '-q', '--bare', origin);
  git(env.repo, 'remote', 'add', 'origin', origin);
  const note = { summary: 'one area', stories: [], prGroups: [{ id: 'cart', title: 'Cart', tickets: ['BUG-1', 'BUG-2', 'BUG-3'], reason: 'same area', risk: 'low' }] };
  const f = fakeDeps(note, { startWorker: fakeWorker().startWorker, openPr: (e) => (git(e.worktree, 'push', '-q', 'origin', e.branch), { url: 'https://github.com/example/repo/pull/101' }) });
  await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: f.deps, log: () => {} });
  assert.equal(loadEpicRun(env.config, 'epic-shop').status, 'delivered');
  const bug1 = env.tickets.find((t) => t.key === 'BUG-1');
  assert.equal(epicToJoin(env.config, [bug1]), null, 'a delivered epic is not joined');
  assert.equal(epicToJoin(env.config, [bug1], { reopen: true, prOpen: () => false }), null, 'its PR merged: a follow-up instead');
  assert.equal(epicToJoin(env.config, [bug1], { reopen: true, prOpen: () => true }).unit.branch, 'bugfix/shop/cart');
  git(env.repo, 'worktree', 'remove', '--force', path.join(env.tmp, 'shop-worktrees', 'bug-1'));
  git(env.repo, 'branch', '-D', 'feat/bug-1');
  const again = fakeWorker({ files: { 'BUG-1': 'src/BUG-1-reopen-fix.cs' } });
  const f2 = fakeDeps(note, { startWorker: again.startWorker });
  const j = await runEpic(env.config, { epic: env.epic, tickets: [bug1], inputs: [env.inputs[env.tickets.indexOf(bug1)]], base: 'main', only: ['BUG-1'], force: true, pr: true, deps: f2.deps, log: () => {} });
  assert.equal(j.epic.outcome, 'joined');
  assert.deepEqual(again.calls.map((c) => [c.key, c.base]), [['BUG-1', 'bugfix/shop/cart']]);
  assert.equal(f2.prs.length, 0, 'the open group PR is reused');
  assert.equal(git(env.repo, 'rev-parse', 'bugfix/shop/cart'), git(origin, 'rev-parse', 'bugfix/shop/cart'), 'the group branch was pushed');
  assert.deepEqual(f2.gates, [{ pr: 'https://github.com/example/repo/pull/101', keys: ['BUG-1', 'BUG-2', 'BUG-3'], worktree: f2.gates[0].worktree, base: 'main' }]);
  assert.ok(f2.board.some((b) => b[0] === 'BUG-1' && b[1] === 'review' && b.includes('https://github.com/example/repo/pull/101')));
});

test('bug epic: a grouping that stays invalid falls back to one PR per bug; a failed group skips the groups that depend on it', async () => {
  const env = makeRepo({ bugs: true });
  const worker = fakeWorker({ outcomes: { 'BUG-1': 'pair-exhausted' } });
  // BUG-2 (blocked by BUG-1) in an earlier group than BUG-1: invalid twice.
  const note = { stories: [], prGroups: [{ id: 'two', tickets: ['BUG-2'] }, { id: 'one', tickets: ['BUG-1', 'BUG-3'] }] };
  const f = fakeDeps(note, { startWorker: worker.startWorker });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: f.deps, log: () => {} });
  assert.equal(f.agentCalls.length, 2, 'asked once more with the errors');
  assert.match(f.agentCalls[1].task, /previous note was rejected[\s\S]*later group/);
  const decisions = readJsonl(path.join(env.repo, '.agent-metrics/decisions.jsonl'));
  assert.equal(decisions.find((d) => d.decision === 'pr-groups').fallback, true);
  assert.deepEqual(Object.fromEntries(r.results.map((x) => [x.key, x.outcome])), { 'BUG-1': 'pair-exhausted', 'BUG-2': 'skipped', 'BUG-3': 'done' });
  assert.deepEqual(f.prs.map((p) => p.branch), ['bugfix/shop/bug-3'], 'only the independent group gets a PR');
  assert.equal(r.epic.outcome, 'stories-failed');
});

test('singleGroups: one group per ticket', () => {
  assert.deepEqual(singleGroups([{ key: 'BUG-1', title: 'a' }]).map((g) => [g.id, g.tickets]), [['bug-1', ['BUG-1']]]);
});
