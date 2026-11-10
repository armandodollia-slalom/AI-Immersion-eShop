// PR check: deterministic scoring, and end-to-end runs of the adversarial loop in a throwaway git repo
// with the scripted fake agent standing in for the critics, defender, judge and fixer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { videoLinks } from '../lib/github.mjs';
import { scoreRound } from '../lib/loop.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fakeAgent = path.join(source, 'scripts', 'pipeline', 'test', 'fixtures', 'fake-agent.mjs');
let repo;
let scriptFile;

const finding = (id, lens, severity, status = 'open') => ({ id, lens, severity, status, title: id, detail: '', evidence: '', requirement: '', fix: 'fix it', thread: [] });

test('scoreRound: nothing upheld scores 10; each upheld severity caps its lens and the PR takes the lowest lens', () => {
  const lenses = ['acceptance', 'flow', 'style'];
  assert.equal(scoreRound({ lenses, findings: [] }).score, 10);
  const r = scoreRound({
    lenses,
    findings: [finding('ACC-1-1', 'acceptance', 'major'), finding('STY-1-1', 'style', 'minor'), finding('FLOW-1-1', 'flow', 'blocking')],
    rulings: [
      { id: 'ACC-1-1', ruling: 'upheld', severity: 'major' },
      { id: 'STY-1-1', ruling: 'upheld', severity: 'minor' },
      { id: 'FLOW-1-1', ruling: 'dismissed' },
    ],
    judgeLensScores: { acceptance: 10, style: 7 },
  });
  assert.deepEqual(r.lensScores, { acceptance: 8, flow: 10, style: 7 });
  assert.equal(r.score, 7);
  assert.deepEqual(r.upheld.map((f) => f.id), ['ACC-1-1', 'STY-1-1']);
});

test('scoreRound: unruled findings stand unless withdrawn, judge coverage gaps count, failed critics score 0', () => {
  const r = scoreRound({
    lenses: ['acceptance', 'flow', 'design'],
    findings: [finding('ACC-1-1', 'acceptance', 'minor'), finding('FLOW-1-1', 'flow', 'blocking', 'withdrawn')],
    rulings: [{ id: 'flow-coverage-1', ruling: 'upheld', severity: 'major', reason: 'AC 2 unverified', fix: 'add it' }],
    failedLenses: ['design'],
  });
  assert.deepEqual(r.lensScores, { acceptance: 9, flow: 8, design: 0 });
  assert.deepEqual(r.upheld.map((f) => [f.id, f.lens]), [['ACC-1-1', 'acceptance'], ['flow-coverage-1', 'flow']]);
});

test('videoLinks finds direct video links and GitHub attachments, once each', () => {
  const body = 'Demo: https://example.com/a/run.webm and ![x](https://github.com/user-attachments/assets/1234-abcd) again https://example.com/a/run.webm. Docs: https://example.com/readme.md';
  assert.deepEqual(videoLinks(body, ['.webm', '.mp4']), ['https://example.com/a/run.webm', 'https://github.com/user-attachments/assets/1234-abcd']);
});

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const calls = () => JSON.parse(fs.readFileSync(`${scriptFile}.calls.json`, 'utf8'));
const prCheck = (args, script) => {
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  const env = { ...process.env, PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main' };
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  return spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', ...args], { cwd: repo, encoding: 'utf8', env });
};

const clean = (lens) => ({ result: { lens, score: 10, summary: 'ok', coverage: [], findings: [] } });
const expiredCoupon = { severity: 'blocking', title: 'Expired coupon is accepted', detail: 'AC 2 says 400', evidence: 'src/Basket/Coupons.cs:1', requirement: 'AC 2', fix: 'reject expired coupons' };
const upheldRound = { result: { score: 6, lensScores: { acceptance: 6 }, summary: 'AC 2 unmet', rulings: [{ id: 'ACC-1-1', ruling: 'upheld', severity: 'blocking', reason: 'conceded', fix: 'reject expired coupons' }] } };

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-check-e2e-'));
  scriptFile = path.join(repo, '..', `${path.basename(repo)}-agent.json`);
  for (const dir of ['scripts/pipeline', 'scripts/pr-check']) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  fs.cpSync(path.join(source, '.github/agents'), path.join(repo, '.github/agents'), { recursive: true });
  write('.gitignore', '.agent-state/\n.agent-metrics/\n');
  write('product-research/stories/DEMO-1-apply-coupon.md', '# DEMO-1 Apply coupon\n\nAC 1: a valid coupon gives 10% off. AC 2: an expired coupon is rejected with 400.\n');
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'qe@example.com']);
  sh('git', ['config', 'user.name', 'QE Test']);
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'init']);
  sh('git', ['switch', '-q', '-c', 'feature/DEMO-1']);
  write('src/Basket/Coupons.cs', '// coupons\n');
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'DEMO-1: coupons']);
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  for (const suffix of ['', '.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
});

test('report-only (--no-fix) runs one round, never calls the fixer, and fails below 10', () => {
  const r = prCheck(['--no-fix', '--json'], {
    'pr-check-acceptance': [{ result: { lens: 'acceptance', score: 6, summary: 'AC 2', coverage: [], findings: [expiredCoupon] } }],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'true' }] } }],
    'pr-check-judge': [upheldRound],
  });
  assert.equal(r.status, 1, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual([result.verdict, result.score, result.rounds], ['FAIL', 6, 1]);
  assert.deepEqual(result.openFindings.map((f) => f.id), ['ACC-1-1']);
  assert.equal(calls()['pr-check-fixer'], undefined);
});

test('the loop debates, fixes, commits and re-reviews with fresh critics until 10/10', () => {
  const head = sh('git', ['rev-parse', 'HEAD']).trim();
  const r = prCheck(['--json'], {
    'pr-check-acceptance': [
      { result: { lens: 'acceptance', score: 6, summary: 'AC 2', coverage: [], findings: [expiredCoupon] } },
      { result: { responses: [{ id: 'ACC-1-1', action: 'maintain', argument: 'the code has no expiry check' }] } },
      clean('acceptance'),
    ],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [
      { result: { responses: [{ id: 'ACC-1-1', position: 'rebut', argument: 'expiry is checked upstream', evidence: 'none' }] } },
      { result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'it is not' }] } },
    ],
    'pr-check-judge': [upheldRound, { result: { score: 10, lensScores: {}, summary: 'all met', rulings: [] } }],
    'pr-check-fixer': [{ writeImpl: 'src/Basket/Coupons.cs', result: { fixed: ['ACC-1-1'], notFixed: [], summary: 'reject expired' } }],
  });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual([result.verdict, result.score, result.rounds, result.commits.length], ['PASS', 10, 2, 1]);
  assert.deepEqual(calls(), { 'pr-check-acceptance': 3, 'pr-check-flow': 2, 'pr-check-style': 2, 'pr-check-defender': 2, 'pr-check-judge': 2, 'pr-check-fixer': 1 });
  assert.match(sh('git', ['log', '-1', '--format=%s']), /DEMO-1: PR check round 1 fixes/);
  assert.notEqual(sh('git', ['rev-parse', 'HEAD^']).trim(), sh('git', ['rev-parse', 'HEAD']).trim());
  assert.equal(sh('git', ['rev-parse', 'HEAD^']).trim(), head);

  const debate = JSON.parse(fs.readFileSync(path.join(repo, '.agent-state/pr-check/DEMO-1/round-1/debate.json'), 'utf8'));
  assert.deepEqual(debate.findings[0].thread.map((t) => t.position ?? t.action), ['rebut', 'maintain', 'concede']);
  const report = fs.readFileSync(path.join(repo, result.report), 'utf8');
  assert.match(report, /# PR check: PASS 10\/10/);
  assert.match(report, /## Resolved during the loop\n\n- ACC-1-1/);
  const metrics = JSON.parse(spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'metrics', '--json'], { cwd: repo, encoding: 'utf8' }).stdout);
  assert.equal(metrics.perfect, 1);
  const [first] = fs.readFileSync(path.join(repo, '.agent-metrics/pr-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    { ...first.upheld[0], detail: undefined },
    { id: 'ACC-1-1', lens: 'acceptance', severity: first.upheld[0].severity, title: expiredCoupon.title, detail: undefined, requirement: expiredCoupon.requirement ?? '', evidence: expiredCoupon.evidence ?? '', repeat: false },
  );
  assert.deepEqual(first.dismissed, []);
});

test('the loop escalates when the fixer cannot fix the upheld findings', () => {
  const r = prCheck(['--json'], {
    'pr-check-acceptance': [{ result: { lens: 'acceptance', score: 6, summary: 'AC 2', coverage: [], findings: [expiredCoupon] } }],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'true' }] } }],
    'pr-check-judge': [upheldRound],
    'pr-check-fixer': [{ result: { fixed: [], notFixed: [{ id: 'ACC-1-1', reason: 'needs a product decision' }], summary: 'blocked' } }],
  });
  assert.equal(r.status, 1, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual([result.verdict, result.rounds], ['ESCALATED', 1]);
  assert.match(fs.readFileSync(path.join(repo, '.agent-state/escalations/DEMO-1-pr-check.md'), 'utf8'), /ACC-1-1/);
});

// Stop-hook flow: the check waits in the background for QE, then hands its findings back to the agent.
const env = () => {
  const e = { ...process.env, PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main' };
  delete e.PIPELINE_CHILD;
  delete e.PIPELINE_DISABLE;
  delete e.PR_CHECK_SKIP;
  return e;
};
const hook = (args, payload = {}) => {
  const r = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'hook', ...args], { cwd: repo, encoding: 'utf8', input: JSON.stringify(payload), env: env() });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const stop = (payload) => {
  const out = hook(['stop'], payload);
  return out ? JSON.parse(out) : null;
};
const stateFile = () => path.join(repo, '.agent-state/stories/DEMO-1.json');
const stateOf = () => JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
const setState = (patch) => {
  const s = fs.existsSync(stateFile()) ? stateOf() : { story: 'DEMO-1' };
  for (const [k, v] of Object.entries(patch)) s[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...s[k], ...v } : v;
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
};
const implHash = () => {
  const code = "import { loadConfig } from './scripts/pipeline/lib/config.mjs'; import { implChanges } from './scripts/pipeline/lib/git.mjs'; console.log(implChanges(loadConfig('pr-check')).hash);";
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: repo, encoding: 'utf8', env: env() }).stdout.trim();
};
const waitFor = async (predicate, timeoutMs = 120_000) => {
  for (const start = Date.now(); Date.now() - start < timeoutMs; ) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out; state: ${JSON.stringify(stateOf().prCheck)}`);
};
// Approve the code now on disk, as the review stage does, with QE in the given state.
const approve = (automation) => {
  const hash = implHash();
  setState({ done: new Date().toISOString(), review: { lastVerdict: 'APPROVED', approvedHash: hash }, automation: automation(hash) });
  return hash;
};

test('Stop hook: waits for QE to verify the tests, checks in the background, then blocks the agent with the findings', async () => {
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/pr-check/config.json'), 'utf8'));
  config.prCheck.hook.pollSec = 0.2;
  write('scripts/pr-check/config.json', JSON.stringify(config, null, 2));
  write('.agent-state/active-story', 'DEMO-1\n');
  fs.writeFileSync(scriptFile, JSON.stringify({
    'pr-check-acceptance': [{ result: { lens: 'acceptance', score: 6, summary: 'AC 2', coverage: [], findings: [expiredCoupon] } }],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'true' }] } }],
    'pr-check-judge': [upheldRound],
  }));
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  hook(['story-start', 'DEMO-1']);
  write('src/Basket/Coupons.cs', '// coupons v3, uncommitted\n');

  assert.equal(stop(), null, 'no check until the review approves the code on disk');
  const hash = approve(() => ({ status: 'running', verifiedHash: null }));
  assert.equal(stop({ hook_event_name: 'SubagentStop', agent_type: 'Explore' }), null, 'only code agents trigger it');
  assert.match(stop().systemMessage, /DEMO-1 will be checked against its story in the background once QE has verified the tests/);
  assert.deepEqual([stateOf().prCheck.status, stateOf().prCheck.hash], ['waiting', hash]);
  assert.equal(stop(), null, 'one waiter per implementation');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(fs.existsSync(`${scriptFile}.calls.json`), false, 'no agent runs while QE is still working');

  setState({ automation: { status: 'verified', verifiedHash: hash } });
  await waitFor(() => stateOf().prCheck.status === 'done');
  assert.deepEqual(calls()['pr-check-fixer'], undefined, 'report only: the agent is the fixer');
  const first = stop();
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /PR check of DEMO-1 scored 6\/10[\s\S]*1\. \[blocking\] ACC-1-1 \(acceptance\) Expired coupon is accepted[\s\S]*Fix them, then finish your turn/);
  assert.match(stop().reason, /still open and nothing has changed/);
  assert.match(stop({ stop_hook_active: true }).systemMessage, /still has 1 open finding/);
  assert.equal(stop(), null);
  assert.match(hook(['session-start']), /PR check for DEMO-1: FAIL 6\/10[\s\S]*ACC-1-1/);
  const record = fs.readFileSync(path.join(repo, '.agent-metrics/pr-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual([record.target, record.round, record.upheld.map((u) => u.id)], ['DEMO-1', 1, ['ACC-1-1']], 'hook runs feed the lessons like any other check');

  // The agent fixes the finding; once review and QE pass the new code, the check runs again and passes.
  write('src/Basket/Coupons.cs', '// coupons v4, rejects expired coupons\n');
  fs.writeFileSync(scriptFile, JSON.stringify({
    'pr-check-acceptance': [clean('acceptance')],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-judge': [{ result: { score: 10, lensScores: {}, summary: 'all met', rulings: [] } }],
  }));
  approve((h) => ({ status: 'verified', verifiedHash: h }));
  assert.match(stop().systemMessage, /checked against its story in the background/);
  await waitFor(() => stateOf().prCheck.status === 'done');
  assert.match(stop().systemMessage, /DEMO-1 scored 10\/10 against its story/);
  assert.equal(stop(), null);
  assert.equal(stateOf().prCheck.runs, 0, 'a pass resets the run count');
});

test('Stop hook: escalates instead of checking again once the run limit is reached', () => {
  write('src/Basket/Coupons.cs', '// coupons v5\n');
  approve((h) => ({ status: 'verified', verifiedHash: h }));
  setState({ prCheck: { status: 'done', hash: 'older', verdict: 'FAIL', score: 6, runs: 3, openFindings: [{ id: 'ACC-1-1', lens: 'acceptance', severity: 'blocking', title: 'x' }], report: 'r.md' } });
  const skipped = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'hook', 'stop'], { cwd: repo, encoding: 'utf8', input: '{}', env: { ...env(), PR_CHECK_SKIP: '1' } });
  assert.equal(skipped.stdout, '', 'PR_CHECK_SKIP=1 turns the hook off');
  assert.match(stop().systemMessage, /still failed after 3 checks\. A human needs to decide/);
  assert.match(fs.readFileSync(path.join(repo, '.agent-state/escalations/DEMO-1-pr-check.md'), 'utf8'), /still failing after 3 PR checks/);
  assert.equal(stateOf().prCheck.status, 'escalated');
  assert.equal(stop(), null);
});