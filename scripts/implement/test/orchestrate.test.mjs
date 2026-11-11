// The orchestrated flow's harness against a real throwaway git repo, with agents, the language server
// daemon and the app stack faked in-process: pairs, scope enforcement, escalation, merge order,
// concurrency, limits, diagnostics and UI verification.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';
import { loadConfig } from '../../pipeline/lib/config.mjs';
import { readJsonl } from '../../pipeline/lib/util.mjs';
import { createContext, orchestrate } from '../lib/orchestrate.mjs';

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = (o) => `Working...\nAGENT_RESULT: ${JSON.stringify(o)}\n`;
const approve = () => result({ verdict: 'APPROVED', summary: 'ok', findings: [] });
const changes = (file, issue) => result({ verdict: 'CHANGES_REQUESTED', summary: 'no', findings: [{ severity: 'blocking', category: 'correctness', file, line: 3, issue, fix: 'do it' }] });
const done = (reason = 'ok') => result({ status: 'done', reason });
const sub = (id, owns, over = {}) => ({ id, goal: `build ${id}`, acceptance: [`${id} works`], owns, dependsOn: [], modelClass: 'medium', verify: 'code', modelReason: 'normal', verifyReason: 'code', expectedFiles: 1, expectedLoc: 5, confidence: 0.9, alternatives: [], ...over });
const plan = (subtasks, over = {}) => result({ mode: 'delegate', modeReason: 'several services', splitReason: 'per service', subtasks, ...over });

function makeRepo(storyText = '# DEMO-1: [BE - Catalog.API] - Thing\n\n## Acceptance Criteria\n\n- it works\n') {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-')));
  const repo = path.join(tmp, 'demo-1');
  write(repo, 'src/Shared/Common.cs', '// shared\n');
  const storyRel = seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-thing', text: storyText });
  write(repo, '.gitignore', '.agent-state/\nartifacts/\n');
  sh(repo, 'init', '-q', '-b', 'feat/demo-1-thing');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 'T');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'init');
  return { tmp, repo, storyFile: path.join(repo, storyRel) };
}

function makeConfig(repo, over = {}) {
  const base = loadConfig('implement', repo);
  return {
    ...base,
    agent: { ...base.agent, cmd: null, cli: 'claude', models: { default: null, implementer: null } },
    implement: { ...base.implement, checks: [], unitTests: null, prepareCmd: null, lsp: { enabled: false }, ...over },
  };
}

const fakeLsp = (over = {}) => ({
  start: async () => ({ ok: true, csharp: 'running' }),
  stop: async (wt) => (fakeLsp.stopped ??= []).push(wt),
  stopAll: async () => {},
  diagnostics: async () => ({ available: false, errors: [], warnings: [] }),
  calls: () => [],
  isReferences: (t) => /referen/.test(t),
  csharpRunning: () => false,
  ...over,
});

// Agents are functions per agent name, consumed in order (the last repeats). Each gets the run options
// and may write files in opts.cwd; it returns the agent's output.
function fakeAgents(script) {
  const calls = [];
  let running = 0;
  const peak = { pairs: 0 };
  const runAgent = async (config, opts) => {
    calls.push(opts);
    const steps = script[opts.name] ?? [];
    const n = calls.filter((c) => c.name === opts.name).length - 1;
    const step = steps[Math.min(n, steps.length - 1)];
    if (opts.name === 'pair-implementer') peak.pairs = Math.max(peak.pairs, ++running);
    try {
      const output = step ? await step(opts) : 'nothing';
      return { ok: true, status: 0, timedOut: false, output, version: 'v1', seconds: 0 };
    } finally {
      if (opts.name === 'pair-implementer') running--;
    }
  };
  return { runAgent, calls, peak };
}

function context(env, config, agents, extra = {}) {
  return createContext({
    config,
    key: 'DEMO-1',
    storyFile: env.storyFile,
    branch: 'feat/demo-1-thing',
    worktree: env.repo,
    base: 'main',
    deps: { runAgent: agents.runAgent, lsp: extra.lsp ?? fakeLsp(), stack: extra.stack, acquire: async () => () => {} },
    log: () => {},
  });
}

const writeIn = (rel, text) => async (opts) => {
  write(opts.cwd, rel, text);
  return done();
};

test('delegate: pairs run at most 2 at a time, dependents branch after their dependency merged, merges follow plan order', async () => {
  const env = makeRepo();
  const config = makeConfig(env.repo, { maxConcurrentPairs: 2 });
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**']), sub('web', ['src/WebApp/**'], { dependsOn: ['api'] }), sub('basket', ['src/Basket.API/**'])])],
    'pair-implementer': [
      async (o) => {
        const id = /subtask "([^"]+)"/.exec(o.task)[1];
        if (id === 'web') assert.ok(fs.existsSync(path.join(o.cwd, 'src/Catalog.API/Api.cs')), 'web starts from the story branch with api merged');
        await sleep(id === 'api' ? 80 : 20);
        write(o.cwd, { api: 'src/Catalog.API/Api.cs', web: 'src/WebApp/Page.cs', basket: 'src/Basket.API/B.cs' }[id], `// ${id}\n`);
        return done();
      },
    ],
    'pair-verifier': [async () => approve()],
  });
  const ctx = context(env, config, agents);
  const r = await orchestrate(ctx);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.mode, 'delegate');
  assert.ok(agents.peak.pairs <= 2, `at most 2 pairs at once (saw ${agents.peak.pairs})`);
  assert.equal(agents.peak.pairs, 2, 'independent subtasks run in parallel');
  const merges = sh(env.repo, 'log', '--merges', '--reverse', '--format=%s').split('\n');
  assert.deepEqual(merges, ['DEMO-1: Merge subtask api', 'DEMO-1: Merge subtask web', 'DEMO-1: Merge subtask basket'], 'plan/dependency order');
  for (const f of ['src/Catalog.API/Api.cs', 'src/WebApp/Page.cs', 'src/Basket.API/B.cs']) assert.ok(fs.existsSync(path.join(env.repo, f)));
  for (const id of ['api', 'web', 'basket']) assert.ok(!fs.existsSync(`${env.repo}--${id}`), `subtask worktree ${id} removed after merge`);
  assert.equal(sh(env.repo, 'branch', '--list', 'feat/demo-1--*'), '', 'subtask branches deleted');

  const plannerCall = agents.calls[0];
  assert.deepEqual([plannerCall.name, plannerCall.mode, plannerCall.noSubagents], ['implementer', 'read', true]);
  const pairCall = agents.calls.find((c) => c.name === 'pair-implementer');
  assert.deepEqual([pairCall.mode, pairCall.noSubagents, pairCall.model], ['implement', true, 'sonnet'], 'the harness passes the class alias; runAgent maps it to the CLI id');
  const verifierCall = agents.calls.find((c) => c.name === 'pair-verifier');
  assert.equal(verifierCall.mode, 'read');
  assert.doesNotMatch(verifierCall.task, /modelReason|normal work|confidence/, 'reasoning never reaches verifiers');
  assert.match(verifierCall.task, /### Diff against the story branch[\s\S]*\+\/\/ (api|basket)/);

  const decisions = readJsonl(path.join(env.repo, '.agent-metrics/decisions.jsonl'));
  const plans = decisions.filter((d) => d.stage === 'implement-plan');
  assert.equal(plans.length, 1);
  assert.deepEqual([plans[0].decision, plans[0].decision_id, plans[0].agent, plans[0].items.length], ['plan-written', ctx.decisionId, 'implementer', 3]);
  assert.ok(plans[0].items.every((i) => i.modelReason && i.verifyReason), 'the reasons behind each subtask choice are in the shared decision log');
  const verdicts = decisions.filter((d) => d.stage === 'implement-verify');
  assert.deepEqual(verdicts.map((d) => [d.subtask, d.decision, d.decision_id === ctx.decisionId]).sort(), [['api', 'approved', true], ['basket', 'approved', true], ['web', 'approved', true]]);
  const runs = readJsonl(path.join(env.repo, '.agent-metrics/subtask-runs.jsonl'));
  assert.deepEqual(runs.map((x) => x.subtaskId).sort(), ['api', 'basket', 'web']);
  assert.ok(runs.every((x) => x.approved && x.rounds.length === 1 && x.decisionId === ctx.decisionId && x.actual.files === 1));
});

test('changes requested go verbatim to the next round, then approval', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'v1'), writeIn('src/Catalog.API/Api.cs', 'v2')],
    'pair-verifier': [async () => changes('src/Catalog.API/Api.cs', 'the owner check is missing'), async () => approve()],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo), agents));
  assert.ok(r.ok);
  const second = agents.calls.filter((c) => c.name === 'pair-implementer')[1];
  assert.match(second.task, /Findings from round 1[\s\S]*src\/Catalog\.API\/Api\.cs:3 the owner check is missing\n {3}Fix: do it/);
  assert.match(second.task, /Round 2 of at most 3/);
});

test('edits outside owns fail the round without asking the verifier', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [
      async (o) => {
        write(o.cwd, 'src/Catalog.API/Api.cs', 'x');
        write(o.cwd, 'src/Shared/Common.cs', 'changed');
        return done();
      },
      async (o) => {
        write(o.cwd, 'src/Shared/Common.cs', '// shared\n');
        return done();
      },
    ],
    'pair-verifier': [async () => approve()],
  });
  const ctx = context(env, makeConfig(env.repo), agents);
  const r = await orchestrate(ctx);
  assert.ok(r.ok);
  assert.equal(agents.calls.filter((c) => c.name === 'pair-verifier').length, 1, 'the out-of-scope round never reached the verifier');
  assert.match(agents.calls.filter((c) => c.name === 'pair-implementer')[1].task, /src\/Shared\/Common\.cs is outside this subtask's owns/);
  const run = readJsonl(path.join(env.repo, '.agent-metrics/subtask-runs.jsonl'))[0];
  assert.equal(run.rounds[0].outOfOwnsEdits, 1);
  assert.deepEqual(run.filesNeededOutsideOwns, ['src/Shared/Common.cs']);
});

test('a pair that exhausts its rounds escalates; a takeover is verified and merged', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [
      async () => plan([sub('api', ['src/Catalog.API/**'])]),
      async (o) => {
        assert.match(o.task, /Escalation for story DEMO-1[\s\S]*still broken/);
        assert.equal(o.cwd, `${env.repo}--api`, 'the takeover happens in the subtask worktree');
        write(o.cwd, 'src/Catalog.API/Api.cs', 'fixed by orchestrator');
        return result({ action: 'takeover', reason: 'spec was fine, pair was not' });
      },
    ],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'try')],
    'pair-verifier': [async () => changes('src/Catalog.API/Api.cs', 'still broken'), async () => changes('src/Catalog.API/Api.cs', 'still broken'), async () => changes('src/Catalog.API/Api.cs', 'still broken'), async () => approve()],
  });
  const ctx = context(env, makeConfig(env.repo), agents);
  const r = await orchestrate(ctx);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(agents.calls.filter((c) => c.name === 'pair-implementer').length, 3);
  assert.equal(ctx.metrics.takeovers, 1);
  assert.equal(fs.readFileSync(path.join(env.repo, 'src/Catalog.API/Api.cs'), 'utf8'), 'fixed by orchestrator');
  assert.equal(readJsonl(path.join(env.repo, '.agent-metrics/subtask-runs.jsonl'))[0].escalation, 'takeover');
});

test('a second failure fails the story with every finding; the subtask worktree is kept for debugging', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])]), async () => result({ action: 'fail', reason: 'needs a split' })],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'try')],
    'pair-verifier': [async () => changes('src/Catalog.API/Api.cs', 'wrong')],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo), agents));
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'pair-exhausted');
  assert.match(r.reason, /subtask api was not approved: needs a split/);
  assert.equal(r.findings.filter((f) => f.issue === 'wrong').length, 3);
  assert.ok(r.findings.every((f) => f.subtask === 'api'));
  assert.ok(fs.existsSync(`${env.repo}--api`));
});

test('the agent-run budget is a hard stop', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'x')],
    'pair-verifier': [async () => changes('src/Catalog.API/Api.cs', 'no')],
  });
  const ctx = context(env, makeConfig(env.repo, { maxAgentRunsPerStory: 4 }), agents);
  const r = await orchestrate(ctx);
  assert.deepEqual([r.ok, r.outcome], [false, 'limit-agent-runs']);
  assert.equal(agents.calls.length, 4);
  assert.equal(ctx.metrics.limitHit, 'limit-agent-runs');
});

test('a plan that breaks the rules is sent back once, then the story fails; too many subtasks fails at once', async () => {
  const env = makeRepo();
  const bad = fakeAgents({ implementer: [async () => plan([sub('a', ['src/A/**']), sub('b', ['src/A/x.cs'])])] });
  const r = await orchestrate(context(env, makeConfig(env.repo), bad));
  assert.deepEqual([r.ok, r.outcome], [false, 'plan-rejected']);
  assert.equal(bad.calls.length, 2);
  assert.match(bad.calls[1].task, /previous plan was rejected[\s\S]*both own files/);
  const decisions = readJsonl(path.join(env.repo, '.agent-metrics/decisions.jsonl')).filter((d) => d.stage === 'implement-plan');
  assert.deepEqual(decisions.map((d) => [d.round, d.decision, d.decision_id]), [[1, 'plan-rejected', null], [2, 'plan-rejected', null]]);
  assert.match(decisions[0].reason, /both own files/);

  const env2 = makeRepo();
  const big = fakeAgents({ implementer: [async () => plan(['a', 'b', 'c', 'd', 'e'].map((id) => sub(id, [`src/${id}/**`])))] });
  const r2 = await orchestrate(context(env2, makeConfig(env2.repo), big));
  assert.equal(r2.outcome, 'plan-rejected');
  assert.match(r2.reason, /^split the story/);
  assert.equal(big.calls.length, 1, 'no second chance');
});

test('language server errors in changed files block approval even when the verifier approves', async () => {
  const env = makeRepo();
  let n = 0;
  const lsp = fakeLsp({ diagnostics: async (wt, files) => ({ available: true, errors: n++ === 0 ? [{ file: files[0], line: 7, col: 2, code: 'CS0103', message: 'name does not exist' }] : [], warnings: [{ file: files[0], line: 1, message: 'unused' }] }) });
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'a'), writeIn('src/Catalog.API/Api.cs', 'b')],
    'pair-verifier': [async () => approve()],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo), agents, { lsp }));
  assert.ok(r.ok);
  const impl = agents.calls.filter((c) => c.name === 'pair-implementer');
  assert.equal(impl.length, 2, 'the approval with errors did not count');
  assert.match(impl[1].task, /src\/Catalog\.API\/Api\.cs:7 compiler\/analyzer error CS0103: name does not exist/);
  assert.match(impl[1].task, /Language server diagnostics[\s\S]*warning src\/Catalog\.API\/Api\.cs:1: unused/);
  assert.match(agents.calls.filter((c) => c.name === 'pair-verifier')[0].task, /error src\/Catalog\.API\/Api\.cs:7:2 CS0103/);
  const run = readJsonl(path.join(env.repo, '.agent-metrics/subtask-runs.jsonl'))[0];
  assert.deepEqual(run.rounds.map((x) => [x.verdict, x.diagnostics.errors]), [['CHANGES_REQUESTED', 1], ['APPROVED', 0]]);
});

test('ui subtasks lease one stack slot for the whole pair, rebuild only changes each round, pass screenshots back, then bring it down and release it', async () => {
  const env = makeRepo('# DEMO-1: [FE - WebApp] - Page\n');
  const stackCalls = [];
  const stack = {
    leaseUntil: async (owner) => (stackCalls.push(['lease', owner]), { ok: true, slot: 3, webappUrl: 'http://localhost:5333' }),
    teststack: async (wt, slot, args) => (stackCalls.push([path.basename(wt), slot, ...args]), { status: 0, stdout: '{}', stderr: '' }),
    release: async (slot) => stackCalls.push(['release', slot]),
    renew: async () => true,
  };
  const agents = fakeAgents({
    implementer: [async () => plan([sub('web', ['src/WebApp/**'], { verify: 'ui', scenario: 'promo' })])],
    'pair-implementer': [writeIn('src/WebApp/Page.razor', 'v1'), writeIn('src/WebApp/Page.razor', 'v2')],
    'pair-ui-verifier': [
      async (o) => {
        const dir = /Save every screenshot under (\S+?) \(/.exec(o.task)[1];
        fs.writeFileSync(path.join(dir, 'cart.png'), 'png');
        write(o.cwd, 'src/WebApp/Page.razor', 'verifier scribble');
        return result({ verdict: 'CHANGES_REQUESTED', summary: 'hidden', findings: [{ severity: 'blocking', screenshot: path.join(dir, 'cart.png'), issue: 'button hidden' }] });
      },
      async () => approve(),
    ],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo), agents, { stack }));
  assert.ok(r.ok, JSON.stringify(r));
  const v = agents.calls.find((c) => c.name === 'pair-ui-verifier');
  assert.equal(v.mode, 'verify');
  assert.equal(v.model, 'opus', 'the UI verifier is large, fixed by the harness');
  assert.match(v.task, /running at http:\/\/localhost:5333/);
  const second = agents.calls.filter((c) => c.name === 'pair-implementer')[1];
  assert.match(second.task, /Screenshot: .*artifacts\/pairs\/DEMO-1\/web\/round-1\/cart\.png/);
  assert.match(second.task, /Screenshots the UI verifier took[\s\S]*cart\.png/);
  assert.deepEqual(
    stackCalls.map((c) => c.join(' ')),
    // Round 1: rebuild-changed before up (so up finds stamped images), then the scenario. Round 2 keeps the
    // slot and the running stack: only rebuild-changed and the scenario. Down and release once, at the end.
    ['lease DEMO-1--web', `demo-1--web 3 rebuild-changed --base ${stackCalls[1][4]}`, 'demo-1--web 3 up', 'demo-1--web 3 load promo', `demo-1--web 3 rebuild-changed --base ${stackCalls[1][4]}`, 'demo-1--web 3 load promo', 'demo-1--web 3 down', 'release 3'],
  );
  assert.equal(fs.readFileSync(path.join(env.repo, 'src/WebApp/Page.razor'), 'utf8'), 'v2', "the verifier's edit was discarded");
});

test('ui subtasks see the mockups; the verifier compares renders with the app every round and design findings reach the implementer with both screenshots', async () => {
  const story = '# DEMO-1: [FE - WebApp] - Coupon page\n\n## Acceptance Criteria\n\n- it works\n';
  const env = makeRepo(story);
  seedTicket(env.repo, { key: 'DEMO-1', slug: 'DEMO-1-thing', text: story, mockups: { 'DEMO-1-coupon/README.md': '# Screens\n', 'DEMO-1-coupon/Main.dc.html': '<x-dc></x-dc>' } });
  const mockDir = path.join(env.repo, '.agent-state', 'board', 'DEMO-1', 'mockups', 'DEMO-1-coupon');
  const stack = { leaseUntil: async () => ({ ok: true, slot: 1, webappUrl: 'http://localhost:5111' }), teststack: async () => ({ status: 0, stdout: '', stderr: '' }), release: async () => {}, renew: async () => true };
  const renders = [];
  const renderMockups = async (o) => {
    renders.push(o);
    fs.mkdirSync(o.outDir, { recursive: true });
    const png = path.join(o.outDir, 'DEMO-1-coupon__Main.png');
    fs.writeFileSync(png, 'png');
    return { ok: true, sha: 'abc', cached: renders.length > 1, entries: [{ kind: 'screen', source: path.join(mockDir, 'Main.dc.html'), screen: 'Main.dc.html', title: 'Coupon', state: 'default', png }] };
  };
  const agents = fakeAgents({
    implementer: [async () => plan([sub('web', ['src/WebApp/**'], { verify: 'ui' })])],
    'pair-implementer': [
      async (o) => (write(o.cwd, 'src/WebApp/Page.razor', 'v1'), result({ status: 'done', reason: 'ok', mockupScreens: ['Main.dc.html (default)'] })),
      writeIn('src/WebApp/Page.razor', 'v2'),
    ],
    'pair-ui-verifier': [
      async (o) => {
        const dir = /Save every screenshot under (\S+?) \(/.exec(o.task)[1];
        const mockup = /- Main\.dc\.html \(Coupon\), state default: (\S+)/.exec(o.task)[1];
        fs.writeFileSync(path.join(dir, 'actual-Main.png'), 'png');
        return result({ verdict: 'CHANGES_REQUESTED', summary: 'label differs', findings: [{ severity: 'blocking', category: 'design', file: 'src/WebApp/Page.razor', mockup, actual: path.join(dir, 'actual-Main.png'), issue: 'button says Apply, mockup says Apply coupon', fix: 'use the mockup copy' }] });
      },
      async () => approve(),
    ],
  });
  const ctx = context(env, makeConfig(env.repo), agents, { stack });
  ctx.deps.renderMockups = renderMockups;
  const r = await orchestrate(ctx);
  assert.ok(r.ok, JSON.stringify(r));

  const planner = agents.calls.find((c) => c.name === 'implementer');
  assert.match(planner.task, /### Mockups/);
  assert.ok(planner.task.includes(path.join(mockDir, 'Main.dc.html')), 'the planner gets the absolute mockup files');
  assert.match(planner.task, /name the mockup screens and states it builds in its acceptance criteria/);
  const [first, second] = agents.calls.filter((c) => c.name === 'pair-implementer');
  assert.ok(first.task.includes(path.join(mockDir, 'README.md')) && first.task.includes(path.join(mockDir, 'Main.dc.html')));
  assert.match(first.task, /Match them: layout, copy, labels, states/);
  assert.match(first.task, /"mockupScreens"/);
  assert.equal(first.extraEnv.PIPELINE_STORY_SOURCES.split(path.delimiter).at(-1), 'DEMO-1', "the story's own ticket is handed to every agent");

  const v = agents.calls.find((c) => c.name === 'pair-ui-verifier');
  assert.match(v.task, /### Mockups: compare the app with the design/);
  assert.match(v.task, /The implementer says it built: Main\.dc\.html \(default\)/);
  assert.match(v.task, /"category": "design"/);
  assert.match(v.task, /node scripts\/implement\/mockups\.mjs diff/);

  // Rendered once per round into the round's mockup/ folder, from one cache.
  assert.deepEqual(renders.map((o) => path.relative(env.repo, o.outDir)), [path.join('artifacts/pairs/DEMO-1/web/round-1/mockup'), path.join('artifacts/pairs/DEMO-1/web/round-2/mockup')]);
  assert.equal(new Set(renders.map((o) => o.cacheDir)).size, 1);
  assert.deepEqual(renders[0].files.map((f) => path.basename(f)).sort(), ['Main.dc.html', 'README.md']);

  // The design finding goes to the next round with the mockup render and the app screenshot.
  assert.match(second.task, /\[design\] src\/WebApp\/Page\.razor button says Apply/);
  assert.match(second.task, /Mockup: .*round-1\/mockup\/DEMO-1-coupon__Main\.png/);
  assert.match(second.task, /Actual: .*round-1\/actual-Main\.png/);
  assert.match(second.task, /Renders of the mockup screens the UI verifier compared with last round:\n- .*DEMO-1-coupon__Main\.png/);
  assert.doesNotMatch(second.task, /Screenshots the UI verifier took[^\n]*\n- [^\n]*mockup\n/, 'the mockup folder is not a screenshot');

  const run = readJsonl(path.join(env.repo, '.agent-metrics/subtask-runs.jsonl'))[0];
  assert.deepEqual(run.rounds.map((x) => x.designFindings), [1, 0]);
  assert.equal(run.designFindings, 1);
  const verdicts = readJsonl(path.join(env.repo, '.agent-metrics/decisions.jsonl')).filter((d) => d.stage === 'implement-verify');
  assert.deepEqual(verdicts.map((d) => d.design_findings), [1, 0]);
  assert.match(verdicts[0].items[0].mockup, /DEMO-1-coupon__Main\.png$/);
});

test('a ticket with mockups is a UI story; its code subtasks still get no mockups', async () => {
  const env = makeRepo();
  seedTicket(env.repo, { key: 'DEMO-1', slug: 'DEMO-1-thing', text: '# DEMO-1: [BE - Catalog.API] - Thing\n', mockups: { 'DEMO-1-x/Main.dc.html': '<x-dc></x-dc>' } });
  const agents = fakeAgents({ implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])], 'pair-implementer': [writeIn('src/Catalog.API/A.cs', 'x')], 'pair-verifier': [async () => approve()] });
  const r = await orchestrate(context(env, makeConfig(env.repo), agents));
  assert.ok(r.ok, JSON.stringify(r));
  const [planCall, ...rest] = agents.calls;
  assert.match(planCall.task, /This IS a UI story[\s\S]*### Mockups/, 'mockups make the [BE] ticket a UI story for the planner');
  for (const c of rest) assert.doesNotMatch(c.task, /### Mockups/, c.name);
});

test('nits and scope: disputes go to the next verifier, accepted ones stop blocking, re-asserted twice stays blocking, follow-ups are recorded', async () => {
  const env = makeRepo();
  const bug = { severity: 'blocking', category: 'correctness', file: 'src/Catalog.API/Api.cs', line: 3, issue: 'the owner check is missing', fix: 'add it' };
  const nit = { severity: 'blocking', category: 'style', file: 'src/Catalog.API/Api.cs', line: 1, issue: 'rename x to total', fix: 'rename' };
  const label = { severity: 'blocking', category: 'correctness', file: 'src/Catalog.API/Api.cs', line: 2, issue: 'the response field must be Total', fix: 'rename the field' };
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])]), async () => result({ action: 'fail', reason: 'give up' })],
    'pair-implementer': [
      writeIn('src/Catalog.API/Api.cs', 'v1'),
      async (o) => (write(o.cwd, 'src/Catalog.API/Api.cs', 'v2'), result({ status: 'done', reason: 'fixed the bug', disputes: [{ finding: 'api-r1-2', kind: 'nit', reason: 'AC 1 says nothing about naming' }, { finding: 'the response field must be Total', kind: 'out-of-scope', reason: 'no AC names the field' }], followUps: [{ title: 'Rename legacy totals', reason: 'confusing names across Catalog.API' }] })),
      async (o) => (write(o.cwd, 'src/Catalog.API/Api.cs', 'v3'), result({ status: 'done', reason: 'no', disputes: [{ finding: 'api-r1-3', kind: 'out-of-scope', reason: 'still no AC' }] })),
      async (o) => (write(o.cwd, 'src/Catalog.API/Api.cs', 'v4'), result({ status: 'done', reason: 'no', disputes: [{ finding: 'api-r1-3', kind: 'out-of-scope', reason: 'still no AC' }] })),
    ],
    'pair-verifier': [
      async () => result({ verdict: 'CHANGES_REQUESTED', summary: 'three', findings: [bug, nit, label] }),
      // Accepts the nit, re-asserts the field name with evidence.
      async () => result({ verdict: 'CHANGES_REQUESTED', summary: 'field', disputes: [{ finding: 'api-r1-2', decision: 'accepted' }, { finding: 'api-r1-3', decision: 'reasserted', evidence: 'AC 2: the API returns Total' }], findings: [{ ...label, id: 'api-r1-3', evidence: 'AC 2: the API returns Total' }] }),
      async () => result({ verdict: 'CHANGES_REQUESTED', summary: 'field', findings: [{ ...label, id: 'api-r1-3', evidence: 'AC 2 again' }] }),
      // After two re-assertions the dispute is overruled: raised again without evidence, it still blocks.
      async () => result({ verdict: 'CHANGES_REQUESTED', summary: 'field', findings: [{ ...label, id: 'api-r1-3' }] }),
    ],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo, { maxPairRounds: 4 }), agents));
  assert.equal(r.ok, false);
  const impl = agents.calls.filter((c) => c.name === 'pair-implementer');
  const ver = agents.calls.filter((c) => c.name === 'pair-verifier');
  assert.match(impl[1].task, /\[id api-r1-2\] src\/Catalog\.API\/Api\.cs:1 rename x to total/);
  assert.match(impl[1].task, /Do not act on nits/);
  assert.match(impl[1].task, /"disputes": \[\{"finding"/);
  assert.match(ver[1].task, /### Disputes from the implementer[\s\S]*- api-r1-2 \(nit\): "rename x to total"\n {2}Implementer: AC 1 says nothing about naming/);
  assert.match(ver[1].task, /- api-r1-3 \(out-of-scope\)/);
  assert.match(impl[2].task, /Re-asserted after your dispute \(1x\): AC 2: the API returns Total/);
  assert.match(impl[3].task, /Re-asserted after your dispute \(2x\): AC 2 again It can no longer be disputed/);
  assert.match(ver[3].task, /api-r1-3: "the response field must be Total" was re-asserted 2 times; the implementer's new dispute is overruled/);

  const run = readJsonl(path.join(env.repo, '.agent-metrics/subtask-runs.jsonl'))[0];
  assert.deepEqual(run.rounds.map((x) => [x.verdict, x.disputes.accepted, x.disputes.reasserted, x.disputes.overruled, x.disputes.followUps]), [['CHANGES_REQUESTED', 0, 0, 0, 0], ['CHANGES_REQUESTED', 1, 1, 0, 1], ['CHANGES_REQUESTED', 0, 1, 0, 0], ['CHANGES_REQUESTED', 0, 0, 1, 0]]);
  assert.deepEqual(run.followUps.map((u) => [u.title, u.subtask, u.round]), [['Rename legacy totals', 'api', 2]]);
  const verdicts = readJsonl(path.join(env.repo, '.agent-metrics/decisions.jsonl')).filter((d) => d.stage === 'implement-verify');
  assert.deepEqual(verdicts[1].disputes.map((d) => [d.finding, d.kind, d.ruling]), [['api-r1-2', 'nit', 'accepted'], ['api-r1-3', 'out-of-scope', 'reasserted']]);
  assert.deepEqual(verdicts[1].follow_ups, [{ title: 'Rename legacy totals', reason: 'confusing names across Catalog.API' }]);
  assert.deepEqual(verdicts[1].items[0].dispute, { kind: 'out-of-scope', ruling: 'reasserted' });
});

test('a disputed nit the verifier raises again without evidence does not block', async () => {
  const env = makeRepo();
  const nit = { severity: 'blocking', category: 'style', file: 'src/Catalog.API/Api.cs', line: 1, issue: 'rename x to total', fix: 'rename' };
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'v1'), async (o) => (write(o.cwd, 'src/Catalog.API/Api.cs', 'v2'), result({ status: 'done', reason: 'ok', disputes: [{ finding: 'api-r1-1', kind: 'nit', reason: 'naming is not in any AC' }] }))],
    'pair-verifier': [async () => result({ verdict: 'CHANGES_REQUESTED', summary: 'nit', findings: [nit] }), async () => result({ verdict: 'CHANGES_REQUESTED', summary: 'nit', findings: [{ ...nit, id: 'api-r1-1' }] })],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo), agents));
  assert.ok(r.ok, JSON.stringify(r));
  const run = readJsonl(path.join(env.repo, '.agent-metrics/subtask-runs.jsonl'))[0];
  assert.deepEqual(run.rounds.map((x) => [x.verdict, x.disputes.nit, x.disputes.accepted]), [['CHANGES_REQUESTED', 0, 0], ['APPROVED', 1, 1]]);
});

test('verify "ui" is rejected for a non-UI story', async () => {
  const env = makeRepo();
  const agents = fakeAgents({ implementer: [async () => plan([sub('web', ['src/WebApp/**'], { verify: 'ui' })])] });
  const r = await orchestrate(context(env, makeConfig(env.repo), agents));
  assert.equal(r.outcome, 'plan-rejected');
  assert.match(agents.calls[1].task, /verify "ui" is only allowed for UI stories/);
});

test('self mode: the orchestrator implements in the story worktree and a verifier approves', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [async () => result({ mode: 'self', modeReason: 'one file' }), writeIn('src/Catalog.API/Api.cs', 'self')],
    'pair-verifier': [async () => approve()],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo), agents));
  assert.deepEqual([r.ok, r.mode], [true, 'self']);
  const impl = agents.calls[1];
  assert.deepEqual([impl.name, impl.mode, impl.cwd, impl.model], ['implementer', 'implement', env.repo, 'opus']);
  assert.match(sh(env.repo, 'log', '-1', '--format=%s'), /DEMO-1: self \(round 1\)/);
});

test('merge conflicts go to the orchestrator in the story worktree', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [
      async () => plan([sub('api', ['src/Catalog.API/**'])]),
      async (o) => {
        assert.match(o.task, /Merge conflict in story DEMO-1[\s\S]*src\/Catalog\.API\/Api\.cs/);
        assert.equal(o.cwd, env.repo);
        write(o.cwd, 'src/Catalog.API/Api.cs', 'resolved');
        sh(o.cwd, 'add', '-A');
        sh(o.cwd, 'commit', '-q', '--no-edit');
        return done();
      },
    ],
    'pair-implementer': [
      async (o) => {
        write(o.cwd, 'src/Catalog.API/Api.cs', 'from pair');
        // Meanwhile someone changes the same file on the story branch.
        write(env.repo, 'src/Catalog.API/Api.cs', 'from story');
        sh(env.repo, 'add', '-A');
        sh(env.repo, 'commit', '-qm', 'concurrent change');
        return done();
      },
    ],
    'pair-verifier': [async () => approve()],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo), agents));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(env.repo, 'src/Catalog.API/Api.cs'), 'utf8'), 'resolved');
  assert.deepEqual(readJsonl(path.join(env.repo, '.agent-metrics/subtask-runs.jsonl'))[0].mergeConflictFiles, ['src/Catalog.API/Api.cs']);
});
