// Escalation questions and the Resolve checkbox (lib/escalation.mjs): the questions step and its
// fallbacks, the failure comment and its marker, reading the answers, `board resolve-check` against a fake
// gh (test/fixtures/fake-gh.mjs), the Decisions section of the issue body, and `board sync` re-queueing
// resolved cards.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetMemo } from '../lib/board.mjs';
import {
  evaluateAnswers,
  extractDecisions,
  failureComment,
  generateQuestions,
  isMechanical,
  keepDecisions,
  nextRound,
  normalizeQuestions,
  parseAnswers,
  parseEscalationMarker,
  renderEscalationComment,
  resolveCheck,
  untickResolved,
  upsertDecisions,
} from '../lib/escalation.mjs';
import { writeDecisionsFile } from '../lib/source.mjs';
import { syncBoard } from '../lib/sync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const COLUMNS = { backlog: 'Backlog', ready: 'Ready', inProgress: 'In Progress', testing: 'Testing', review: 'Pending Review', failed: 'Failed', done: 'Done' };
const OPTIONS = Object.fromEntries(Object.values(COLUMNS).map((name, i) => [name, `opt-${i}`]));
const BOARD = { repo: 'acme/shop', owner: 'acme', ownerType: 'user', projectNumber: 1, statusField: 'Status', columns: COLUMNS, storyLabel: 'story', blockedLabel: 'needs-human', epicLabel: 'epic', resolvedLabel: 'escalation-resolved' };
const baseConfig = { root: '/nowhere', stateDir: '.agent-state', board: BOARD, agent: { models: { escalationQuestions: 'sonnet' } } };

const QUESTIONS = normalizeQuestions({
  questions: [
    { title: 'What should the cart show after the discount is removed?', context: 'The story says recalculate; the basket API caches the line price.', options: [{ text: 'Recalculate from the catalog price', recommended: true }, { text: 'Keep the cached line price until checkout' }] },
    { title: 'Is the basket API change in scope?', context: 'Fixing only the WebApp hides it for other clients.', options: [{ text: 'Yes, fix it in Basket.API' }, { text: 'No, WebApp only; open a follow-up' }] },
  ],
});

// A git repo, a fake gh first on PATH and its state.
function fixture(issues = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-escalation-'));
  spawnSync('git', ['init', '-q', root]);
  const bin = path.join(root, '.bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fixtures', 'fake-gh.mjs')}" "$@"\n`, { mode: 0o755 });
  const stateFile = path.join(root, '.gh.json');
  fs.writeFileSync(stateFile, JSON.stringify({ repo: 'acme/shop', login: 'pipeline-bot-user', options: OPTIONS, issues }));
  Object.assign(process.env, { PATH: `${bin}:/usr/bin:/bin`, FAKE_GH_STATE: stateFile, PIPELINE_BOARD_OWNER: 'me@box' });
  resetMemo();
  const config = { ...baseConfig, root };
  const gh = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return { root, config, gh, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const tick = (body, ...ids) => {
  let b = body;
  for (const id of ids) {
    const [q, o] = id.split('-');
    const at = b.indexOf(`### ${q}.`);
    const line = o === 'Other' ? '- [ ] **Other**' : `- [ ] **${o}.**`;
    const i = b.indexOf(line, at);
    b = `${b.slice(0, i)}${line.replace('[ ]', '[x]')}${b.slice(i + line.length)}`;
  }
  return b;
};
const tickResolved = (body) => body.replace("- [ ] **Resolved**", "- [x] **Resolved**");

test('mechanical failures get no questions and the agent is not called', () => {
  let called = 0;
  const runAgent = () => {
    called++;
    return { ok: true, output: 'AGENT_RESULT: {"questions": []}' };
  };
  for (const r of [{ outcome: 'error', reason: 'worker exited 1 without a result' }, { outcome: 'qe-crashed' }, { outcome: 'qe-timed-out' }, { outcome: 'blocked-x', reason: 'the agent provider is unavailable (quota)' }, {}]) {
    assert.ok(isMechanical(r), JSON.stringify(r));
    assert.deepEqual(generateQuestions(baseConfig, 'DEMO-1', r, { runAgent }), { questions: [], mechanical: true, error: null });
  }
  assert.equal(called, 0);
  assert.ok(!isMechanical({ outcome: 'qe-escalated', reason: 'QE ended escalated' }));
  assert.ok(!isMechanical({ outcome: 'blocked', reason: 'Open Question 2 is unanswered' }));
});

test('the questions step asks Sonnet with the notes, findings and log, and falls back when it fails', () => {
  const calls = [];
  const ok = (opts) => {
    calls.push(opts);
    return { ok: true, output: `thinking...\nAGENT_RESULT: ${JSON.stringify({ questions: [{ title: 'Q?', context: 'c', options: [{ text: 'a' }, { text: 'b', recommended: true }, { text: 'Other' }] }] })}` };
  };
  const result = { outcome: 'qe-escalated', reason: 'QE ended escalated', findings: ['TC-03 expects 0'] };
  const r = generateQuestions(baseConfig, 'DEMO-1', result, { runAgent: (_c, o) => ok(o), notes: [{ stage: 'qe', text: 'the plan and the story disagree' }], story: '# DEMO-1 Cart' });
  assert.equal(r.error, null);
  assert.equal(r.questions.length, 1);
  assert.deepEqual(r.questions[0].options.map((o) => [o.id, o.recommended]), [['A', false], ['B', true]], '"Other" is added by the comment, not the agent');
  assert.equal(calls[0].name, 'escalation-questions');
  assert.equal(calls[0].model, 'sonnet');
  assert.equal(calls[0].mode, 'read');
  assert.match(calls[0].task, /the plan and the story disagree/);
  assert.match(calls[0].task, /TC-03 expects 0/);

  assert.match(generateQuestions(baseConfig, 'DEMO-1', result, { runAgent: () => ({ ok: false, status: 1 }) }).error, /failed \(exit 1\)/);
  assert.match(generateQuestions(baseConfig, 'DEMO-1', result, { runAgent: () => ({ ok: true, output: 'no result line' }) }).error, /no AGENT_RESULT/);
  assert.match(generateQuestions(baseConfig, 'DEMO-1', result, { runAgent: () => { throw new Error('sonnet is not allowed'); } }).error, /sonnet is not allowed/);
});

test('questions are validated: at most 3, 2-3 options, exactly one recommended, safe text', () => {
  const qs = normalizeQuestions({
    questions: [
      { title: 'One option only', options: [{ text: 'a' }] },
      { title: '## <!-- x --> Two recommended - [ ] box', options: [{ text: 'a', recommended: true }, { text: 'b', recommended: true }, { text: 'c' }, { text: 'd' }] },
      { title: 'q3', options: ['a', 'b'] },
      { title: 'q4', options: ['a', 'b'] },
      { title: 'q5', options: ['a', 'b'] },
    ],
  });
  assert.equal(qs.length, 3);
  assert.deepEqual(qs.map((q) => q.id), ['Q1', 'Q2', 'Q3']);
  assert.equal(qs[0].title, 'x Two recommended - ( ) box', 'no heading, comment or checkbox syntax survives');
  assert.equal(qs[0].options.length, 3);
  assert.deepEqual(qs[0].options.map((o) => o.recommended), [true, false, false]);
  assert.deepEqual(qs[1].options.map((o) => o.recommended), [true, false], 'none recommended: the first is');
});

test('the failure comment: summary, questions as task lists, details collapsed, Resolved box and marker', () => {
  const result = { outcome: 'qe-escalated', reason: 'QE ended escalated', branch: 'fix/g1', log: '.agent-state/logs/x.log', findings: [{ file: 'src/A.cs', line: 3, issue: 'wrong total' }] };
  const body = renderEscalationComment(baseConfig, { key: 'BUG-1', result, questions: QUESTIONS, notes: [{ stage: 'qe', text: '# BUG-1 qe\n\n- [ ] a checkbox inside the note' }], round: 1, host: 'box' });
  assert.match(body, /^The pipeline stopped: \*\*qe-escalated\*\* \(QE ended escalated\)\./);
  assert.match(body, /I need 2 decisions from you/);
  assert.match(body, /### Q1\. What should the cart show/);
  assert.match(body, /- \[ \] \*\*A\.\*\* Recalculate from the catalog price _\(recommended\)_/);
  assert.match(body, /- \[ \] \*\*Other\*\* \(reply in a new comment that starts with `Q2:`\)/);
  assert.match(body, /<details><summary>Details: 1 escalation note, 1 finding, branch, log<\/summary>/);
  assert.match(body, /`src\/A\.cs:3` wrong total/);
  assert.match(body, /Branch: `fix\/g1`\. Log on `box`/);
  assert.ok(body.indexOf('</details>') < body.indexOf("- [ ] **Resolved**: I've answered the questions; re-queue this ticket"));
  const marker = parseEscalationMarker(body);
  assert.deepEqual(marker, { key: 'BUG-1', round: 1, questions: [{ id: 'Q1', options: ['A', 'B'] }, { id: 'Q2', options: ['A', 'B'] }] });
  const parsed = parseAnswers(body);
  assert.deepEqual(Object.keys(parsed.questions), ['Q1', 'Q2'], 'the checkbox inside the details is ignored');
  assert.equal(parsed.resolved, false);

  const mech = renderEscalationComment(baseConfig, { key: 'BUG-1', result: { outcome: 'qe-crashed' }, mechanical: true });
  assert.match(mech, /mechanical failure/);
  assert.match(mech, /- \[ \] \*\*Resolved\*\*/);
  assert.deepEqual(parseEscalationMarker(mech).questions, []);
  assert.match(renderEscalationComment(baseConfig, { key: 'BUG-1', result, questionsError: 'the agent timed out' }), /I could not prepare questions \(the agent timed out\)/);
  assert.equal(nextRound([{ body: 'x' }, { body: body }]), 2);
  assert.match(renderEscalationComment(baseConfig, { key: 'BUG-1', result, round: 2 }), /Round 2; earlier answers are under \*\*Decisions\*\*/);
});

test('failureComment reads the escalation notes from the ticket worktree and the round from the issue', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-wt-'));
  fs.mkdirSync(path.join(wt, '.agent-state', 'escalations'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.agent-state', 'escalations', 'BUG-1-qe.md'), '# BUG-1 qe: did not converge\n\nTC-02 contradicts the story.\n');
  fs.writeFileSync(path.join(wt, '.agent-state', 'escalations', 'BUG-10-qe.md'), 'another ticket');
  try {
    let task = '';
    const body = failureComment({ ...baseConfig, root: wt }, 'BUG-1', { outcome: 'qe-escalated', worktree: wt }, { comments: [{ body: renderEscalationComment(baseConfig, { key: 'BUG-1', round: 1 }) }], runAgent: (_c, o) => ((task = o.task), { ok: false, status: 2 }) });
    assert.match(task, /TC-02 contradicts the story/);
    assert.doesNotMatch(task, /another ticket/);
    assert.match(body, /#### Escalation note: qe/);
    assert.match(body, /I could not prepare questions/);
    assert.equal(parseEscalationMarker(body).round, 2);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('answers: complete, missing option, two ticked, Other without a reply, bot replies ignored', () => {
  const body = renderEscalationComment(baseConfig, { key: 'BUG-1', questions: QUESTIONS, round: 1 });
  const marker = parseEscalationMarker(body);
  const human = (text) => ({ author: 'armando', body: text });

  const done = evaluateAnswers(marker, tickResolved(tick(body, 'Q1-A', 'Q2-Other')), [human('Q2: Fix it in Basket.API, but in a separate PR.\nLink the follow-up.')]);
  assert.equal(done.complete, true);
  assert.equal(done.resolved, true);
  assert.deepEqual(done.answers.map((a) => [a.id, a.choice, a.text]), [['Q1', 'A', 'Recalculate from the catalog price'], ['Q2', 'Other', 'Fix it in Basket.API, but in a separate PR.\nLink the follow-up.']]);

  assert.deepEqual(evaluateAnswers(marker, tick(body, 'Q1-A'), []).missing, ['Q2 has no answer ticked.']);
  assert.match(evaluateAnswers(marker, tick(body, 'Q1-A', 'Q1-B', 'Q2-A'), []).missing[0], /Q1 has 2 answers ticked \(A, B\)/);
  assert.deepEqual(evaluateAnswers(marker, tick(body, 'Q1-A', 'Q2-Other'), []).missing, ['Q2 has "Other" ticked but no `Q2:` reply.']);
  const bots = [{ author: 'github-actions', body: 'Q2: from a bot' }, { author: 'renovate[bot]', body: 'Q2: x' }, { author: 'armando', body: 'Q2: quoted <!-- pipeline-board:{} -->' }];
  assert.equal(evaluateAnswers(marker, tick(body, 'Q1-A', 'Q2-Other'), bots).complete, false, 'bot and pipeline comments never answer');
  assert.equal(evaluateAnswers(marker, tick(body, 'Q1-B', 'Q2-B'), []).complete, true);
  assert.equal(untickResolved(tickResolved(body)), body);
});

test('the Decisions section: added after the source, rounds replaced in place, idempotent, kept on publish', () => {
  const issue = '<!-- board-ticket:v1\n{}\n-->\n> header\n\n<!-- board-ticket:source:begin -->\n# BUG-1\n<!-- board-ticket:source:end -->\n';
  const answers = [{ id: 'Q1', title: 'What should the cart show?', choice: 'A', text: 'Recalculate', other: false }, { id: 'Q2', title: 'In scope?', choice: 'Other', text: 'Separate PR\nfor the API', other: true }];
  const once = upsertDecisions(issue, { round: 1, by: 'armando', at: '2026-11-11T10:21:00Z', answers });
  assert.ok(once.startsWith(issue.trimEnd()), 'the source block is untouched');
  assert.match(once, /## Decisions/);
  assert.match(once, /### Round 1 \(resolved by @armando, 2026-11-11T10:21:00Z\)/);
  assert.match(once, /- \*\*Q1\. What should the cart show\?\*\* A\. Recalculate/);
  assert.match(once, /- \*\*Q2\. In scope\?\*\* Other: Separate PR for the API/);
  assert.equal(upsertDecisions(once, { round: 1, by: 'someone', at: '2026-11-12T00:00:00Z', answers }), once, 'same answers: unchanged');
  const changed = upsertDecisions(once, { round: 1, by: 'armando', at: '2026-11-12T00:00:00Z', answers: [answers[0]] });
  assert.equal((changed.match(/### Round 1/g) ?? []).length, 1, 'a round is replaced, never duplicated');
  const two = upsertDecisions(changed, { round: 2, by: 'lee', at: '2026-11-13T00:00:00Z', answers: [{ id: 'Q1', title: 'Again?', choice: 'B', text: 'No', other: false }] });
  assert.ok(two.indexOf('### Round 1') < two.indexOf('### Round 2'), 'earlier rounds stay as context');
  assert.equal((two.match(/## Decisions/g) ?? []).length, 1);
  const text = extractDecisions(two);
  assert.match(text, /^## Decisions/);
  assert.match(text, /### Round 2/);
  assert.equal(extractDecisions(issue), null);
  const republished = keepDecisions(issue, two);
  assert.equal(extractDecisions(republished), text, 'board publish keeps the decisions');
  assert.equal(keepDecisions(two, two), two);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-dec-'));
  writeDecisionsFile(dir, two);
  assert.equal(fs.readFileSync(path.join(dir, 'decisions.md'), 'utf8'), `${text}\n`);
  writeDecisionsFile(dir, issue);
  assert.ok(!fs.existsSync(path.join(dir, 'decisions.md')), 'no decisions on the issue: the cached file goes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolve-check: incomplete answers untick Resolved and reply with what is missing', () => {
  const body = renderEscalationComment(baseConfig, { key: 'BUG-1', questions: QUESTIONS, round: 1 });
  const f = fixture({ 43: { title: 'BUG-1: Cart', labels: ['story', 'needs-human'], body: 'issue body', comments: [{ id: 501, body: tickResolved(tick(body, 'Q1-A', 'Q2-Other')) }] } });
  try {
    const r = resolveCheck(f.config, 43, { actor: 'armando', comment: '501' });
    assert.equal(r.status, 'incomplete');
    const i = f.gh().issues['43'];
    assert.match(i.comments[0].body, /- \[ \] \*\*Resolved\*\*/, 'Resolved is unticked');
    assert.match(i.comments[0].body, /- \[x\] \*\*A\.\*\*/, 'the answers stay ticked');
    assert.match(i.comments.at(-1).body, /Not resolved yet, @armando:\n\n- Q2 has "Other" ticked but no `Q2:` reply\./);
    assert.deepEqual(i.labels, ['story', 'needs-human']);
    assert.equal(i.body, 'issue body');
    assert.equal(resolveCheck(f.config, 43, { actor: 'armando' }).status, 'not-ticked', 'after the untick, the edit event is a no-op');
  } finally {
    f.cleanup();
  }
});

test('resolve-check: complete answers swap the labels, record the decisions and confirm; replays are no-ops', () => {
  const body = renderEscalationComment(baseConfig, { key: 'BUG-1', questions: QUESTIONS, round: 1 });
  const f = fixture({
    43: {
      title: 'BUG-1: Cart',
      labels: ['story', 'needs-human'],
      body: '<!-- board-ticket:source:begin -->\n# BUG-1\n<!-- board-ticket:source:end -->\n',
      comments: [{ id: 400, body: renderEscalationComment(baseConfig, { key: 'BUG-1', round: 1 }) }, { id: 501, body: tickResolved(tick(body, 'Q1-A', 'Q2-Other')) }, { id: 502, author: 'github-actions', body: 'Q2: bot' }, { id: 503, author: 'armando', body: 'Q2: Fix it in Basket.API, but in a separate PR.' }],
    },
  });
  try {
    f.gh();
    const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
    state.knownLabels = ['story', 'needs-human'];
    fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
    assert.equal(resolveCheck(f.config, 43, { actor: 'armando', comment: '400' }).status, 'not-latest', 'an older failure comment is ignored');
    const r = resolveCheck(f.config, 43, { actor: 'armando', comment: '501', now: '2026-11-11T10:21:00Z' });
    assert.equal(r.status, 'resolved');
    const i = f.gh().issues['43'];
    assert.deepEqual(i.labels.sort(), ['escalation-resolved', 'story'], 'needs-human swapped for escalation-resolved (label created)');
    assert.match(i.body, /### Round 1 \(resolved by @armando, 2026-11-11T10:21:00Z\)/);
    assert.match(i.body, /Q2\. Is the basket API change in scope\?\*\* Other: Fix it in Basket\.API, but in a separate PR\./);
    assert.match(i.comments.at(-1).body, /^✅ Resolved by @armando\. Decisions recorded: Q1 → A, Q2 → "Fix it in Basket\.API, but in a separate PR\."/);
    const comments = i.comments.length;
    assert.equal(resolveCheck(f.config, 43, { actor: 'armando' }).status, 'already-resolved');
    assert.equal(f.gh().issues['43'].comments.length, comments, 'no second confirmation');
  } finally {
    f.cleanup();
  }
});

test('resolve-check: a human adding escalation-resolved by hand counts as resolved', () => {
  const body = renderEscalationComment(baseConfig, { key: 'BUG-1', questions: QUESTIONS, round: 1 });
  const f = fixture({
    43: { title: 'BUG-1: Cart', labels: ['story', 'needs-human', 'escalation-resolved'], body: 'b', comments: [{ id: 501, body: tick(body, 'Q1-B') }] },
    44: { title: 'BUG-2: Old', labels: ['story', 'needs-human', 'escalation-resolved'], body: 'b', comments: [{ id: 601, body: 'The pipeline stopped (old format).' }] },
  });
  try {
    const r = resolveCheck(f.config, 43, { actor: 'lee', viaLabel: true, now: '2026-11-11T11:00:00Z' });
    assert.equal(r.status, 'resolved');
    const i = f.gh().issues['43'];
    assert.deepEqual(i.labels, ['story', 'escalation-resolved']);
    assert.match(i.body, /Q1\. What should the cart show after the discount is removed\?\*\* B\. Keep the cached line price until checkout/);
    assert.match(i.body, /Marked resolved with the `escalation-resolved` label; unanswered: Q2 has no answer ticked\./);
    assert.equal(resolveCheck(f.config, 44, { actor: 'lee', viaLabel: true }).status, 'resolved');
    assert.deepEqual(f.gh().issues['44'].labels, ['story', 'escalation-resolved']);
    assert.equal(resolveCheck(f.config, 44, { actor: 'lee' }).status, 'no-escalation');
  } finally {
    f.cleanup();
  }
});

test('board sync moves resolved Failed cards to Ready, and only those', () => {
  const f = fixture({
    12: { title: 'BUG-1: Resolved', labels: ['story', 'escalation-resolved'], item: 'I12', column: 'Failed', comments: [] },
    13: { title: 'BUG-2: Still needs a human', labels: ['story', 'escalation-resolved', 'needs-human'], item: 'I13', column: 'Failed', comments: [] },
    14: { title: 'BUG-3: Failed', labels: ['story', 'needs-human'], item: 'I14', column: 'Failed', comments: [] },
    15: { title: 'BUG-4: Already re-queued', labels: ['story', 'escalation-resolved'], item: 'I15', column: 'Ready', comments: [] },
    16: { title: 'BUG-5: Running', labels: ['story', 'escalation-resolved'], item: 'I16', column: 'In Progress', comments: [] },
  });
  try {
    const r = syncBoard(f.config, { listStories: () => [] });
    assert.deepEqual(r.requeued, ['BUG-1']);
    assert.deepEqual(r.resolved.sort(), ['BUG-1', 'BUG-4']);
    const col = (n) => f.gh().issues[n].column;
    assert.deepEqual([col(12), col(13), col(14), col(15), col(16)], ['Ready', 'Failed', 'Failed', 'Ready', 'In Progress']);
    assert.deepEqual(syncBoard(f.config, { listStories: () => [] }).requeued, [], 'idempotent');
  } finally {
    f.cleanup();
  }
});
