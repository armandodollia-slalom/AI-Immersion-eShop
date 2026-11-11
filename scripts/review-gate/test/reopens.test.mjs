// Review gate, step 3: human reopens (card moved back, issue reopened, changes requested), the severity
// bump, the Decisions note for the re-run, and the PR's gate going back to review.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readJsonl } from '../../pipeline/lib/util.mjs';
import { extractDecisions } from '../../board/lib/escalation.mjs';
import { nextLane } from '../../board/lib/flow.mjs';
import { placeReopened, isReopened } from '../../implement/lib/reopen.mjs';
import { batchesFor } from '../../implement/lib/requeue.mjs';
import { encodeState, parseState } from '../lib/gate.mjs';
import { cardReopen, newChangesRequested, reopenDecisionNote, reviewTargets, withReopen } from '../lib/reopens.mjs';
import { syncGate } from '../lib/sync.mjs';
import { extractTriage, upsertTriage } from '../lib/triage-section.mjs';
import { fakeGh } from './fake-gh.mjs';
import { SETTINGS, gateConfigFor } from './helpers.mjs';

test('card and issue reopens: only a move with no pipeline event behind it counts', () => {
  assert.equal(cardReopen({ column: 'inProgress' }, { column: 'review' }).source, 'card');
  assert.equal(cardReopen({ column: 'inProgress' }, { column: 'done' }).source, 'card');
  assert.equal(cardReopen({ column: 'inProgress' }, { column: 'inProgress', event: 'claim' }), null, 'the pipeline claimed it again');
  assert.equal(cardReopen({ column: 'inProgress' }, { column: 'inProgress', event: 'reopened' }), null, 'already counted');
  assert.equal(cardReopen({ column: 'review' }, { column: 'review' }), null);
  assert.equal(cardReopen({ column: 'done', state: 'OPEN', stateReason: 'REOPENED' }, { column: 'review' }).source, 'issue');
  assert.equal(cardReopen({ column: 'done', state: 'CLOSED' }, { column: 'review' }), null);
  assert.equal(nextLane('done', 'reopened'), 'inProgress');
  assert.equal(nextLane('testing', 'reopened'), null, 'only QE moves Testing back');
});

test('changes requested: against the tickets a review names (body or inline comments), else all; each review once', () => {
  const keys = ['BUG-3', 'BUG-7', 'BUG-9'];
  const reviews = [
    { id: 1, state: 'CHANGES_REQUESTED', body: 'BUG-7 still logs the token', user: { login: 'ann' } },
    { id: 2, state: 'CHANGES_REQUESTED', body: 'please fix', user: { login: 'bob' } },
    { id: 3, state: 'APPROVED', body: 'BUG-3 ok', user: { login: 'cy' } },
    { id: 4, state: 'CHANGES_REQUESTED', body: '', user: { login: 'dee' } },
  ];
  const comments = [{ pull_request_review_id: 4, path: 'src/Basket.API/A.cs', line: 12, body: 'BUG-9: off by one' }];
  assert.deepEqual(reviewTargets(reviews[0], comments, keys), ['BUG-7']);
  assert.deepEqual(reviewTargets(reviews[1], comments, keys), keys);
  const fresh = newChangesRequested(reviews, comments, keys, [1]);
  assert.deepEqual(fresh.map((f) => [f.review.id, f.keys]), [[2, keys], [4, ['BUG-9']]]);
  assert.match(fresh[1].feedback, /`src\/Basket\.API\/A\.cs:12`: BUG-9: off by one/);
});

test('a reopen bumps the stored severity from the stored ratings and leaves a binding note for the re-run', () => {
  const triage = { impact: 'Medium', fixRisk: 'Low', complexity: 'Low', floorReasons: [], reopens: [] };
  const once = withReopen(triage, { at: 't1', source: 'card' }, SETTINGS);
  assert.equal(once.severity.level, 'High');
  assert.equal(once.severity.explanation, 'Impact Medium, Fix risk Low → Medium, +1 reopen → High');
  assert.equal(withReopen(withReopen(once, { at: 't2', source: 'card' }, SETTINGS), { at: 't3', source: 'card' }, SETTINGS).severity.level, 'Severe');
  assert.match(reopenDecisionNote({ source: 'changes-requested', by: 'ann', pr: 'https://x/pull/5', feedback: 'BUG-7 still logs\nthe token' }), /^Human reopen \(Changes requested by @ann on https:\/\/x\/pull\/5\): BUG-7 still logs the token$/);
  assert.match(reopenDecisionNote({ source: 'card', afterMerge: true }), /Card moved back to In Progress, after the PR merged\): no reason given/);
});

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-sync-'));
  const gh = fakeGh();
  gh.addFields();
  const triage = (key, pr, extra = {}) => ({ v: 1, key, pr, impact: 'Low', impactReason: 'r', complexity: 'Low', fixRisk: 'Low', fixRiskReason: 'r', floorReasons: [], severity: { level: 'Low', base: 'Low', bump: 0, explanation: 'Impact Low, Fix risk Low → Low' }, confidence: { score: 98, high: true, criteria: { qe: 'met', pairs: 'met', prCheck: 'met', owns: 'met', ci: 'met' }, reasons: [] }, systems: ['Basket.API'], paths: ['src/Basket.API/A.cs'], reopens: [], ...extra });
  const pr = gh.addPr(5, { author: 'pipeline-bot', labels: ['approvals:0'], checks: [{ name: 'ci', bucket: 'pending' }], headRefOid: 'h1' });
  const state = { v: 1, action: 'wait', approvals: 0, required: false, triggers: [], headSha: 'h1', class: 'Low', severity: 'Low', systems: { names: ['Basket.API'], shared: false, contract: false }, tickets: [{ key: 'BUG-3', issue: 3, severity: 'Low', high: true, reopens: 0 }, { key: 'BUG-7', issue: 7, severity: 'Low', high: true, reopens: 0 }], countedReviews: [] };
  pr.comments.push({ id: 900, body: `## Review gate: waiting for the checks\n\n${encodeState(state)}` });
  gh.addIssue(3, { body: upsertTriage('story 3', triage('BUG-3', pr.url)), assignees: ['dana'] });
  gh.addIssue(7, { body: upsertTriage('story 7', triage('BUG-7', pr.url)) });
  for (const n of [3, 7]) gh.items.set(n, { id: `I_${n}`, values: { Severity: 'Low', 'Human reopens': 0 } });
  const config = gateConfigFor(root);
  const events = [];
  const deps = (items, extra = {}) => ({ gh: gh.gh, items, metricsConfig: config, markerOf: () => ({ column: 'review', at: '2026-11-01T00:00:00Z' }), commentsOf: () => [{ author: 'dana', body: 'still broken on Safari', createdAt: '2026-11-02T00:00:00Z' }], applyEvent: (key, ev) => events.push([key, ev.type, ev.id]), now: '2026-11-03T00:00:00Z', ...extra });
  return { root, gh, pr, config, events, deps };
}

test('sync: a card moved back records the reopen, bumps severity, notes it for the re-run and sends the open PR to review', () => {
  const w = world();
  const items = [
    { key: 'BUG-3', number: 3, url: 'u3', column: 'inProgress', state: 'OPEN', severity: 'Low', labels: [] },
    { key: 'BUG-7', number: 7, url: 'u7', column: 'review', state: 'OPEN', severity: 'Low', labels: [] },
    { key: 'PROMO-1', number: 1, column: 'inProgress', state: 'OPEN', severity: null, labels: [] },
  ];
  const r = syncGate(w.config, w.deps(items));
  assert.deepEqual(r.reopens, ['BUG-3']);
  const t3 = extractTriage(w.gh.issues.get(3).body);
  assert.equal(t3.reopens.length, 1);
  assert.equal(t3.severity.level, 'Medium');
  assert.equal(t3.reopens[0].feedback, '@dana: still broken on Safari');
  assert.match(extractDecisions(w.gh.issues.get(3).body), /### Round 1[\s\S]*Human reopen \(Card moved back to In Progress\): @dana: still broken on Safari/);
  assert.ok(w.gh.issues.get(3).labels.includes('reopened'));
  assert.deepEqual(w.gh.items.get(3).values, { Impact: 'Low', Complexity: 'Low', 'Fix risk': 'Low', Severity: 'Medium', Confidence: 98, 'Human reopens': 1 });
  assert.deepEqual(w.events, [['BUG-3', 'reopened', 'reopen:BUG-3:1']]);
  const [rec] = readJsonl(path.join(w.root, '.agent-metrics/decision-outcomes.jsonl'));
  assert.deepEqual([rec.type, rec.story, rec.source, rec.afterMerge, rec.severity], ['reopen', 'BUG-3', 'card', false, 'Medium']);
  // The open PR: review, 1 approval, needs-human; the notice says why; auto-merge turned off.
  assert.deepEqual(r.regated, [w.pr.url]);
  assert.deepEqual(w.pr.labels.sort(), ['approvals:1', 'needs-human']);
  const notice = w.pr.comments[0].body;
  assert.match(notice, /BUG-3 is Medium[\s\S]*BUG-3 has 1 human reopen/);
  assert.match(notice, /BUG-7 would have auto-merged/);
  assert.equal(parseState(notice).required, true);
  assert.ok(w.gh.calls.some((c) => c.args.includes('--disable-auto')));
  assert.deepEqual(w.pr.reviewers, ['dana']);
});

test('sync: a changes-requested review reopens the tickets it names, once', () => {
  const w = world();
  w.pr.reviews.push({ id: 41, state: 'CHANGES_REQUESTED', body: 'BUG-7: the token is still in the log', user: { login: 'ann' }, submitted_at: '2026-11-02T10:00:00Z', commit_id: 'h1' });
  const r = syncGate(w.config, w.deps([]));
  assert.deepEqual(r.reopens, ['BUG-7']);
  const t7 = extractTriage(w.gh.issues.get(7).body);
  assert.equal(t7.reopens[0].source, 'changes-requested');
  assert.equal(t7.reopens[0].by, 'ann');
  assert.match(extractDecisions(w.gh.issues.get(7).body), /Changes requested by @ann on https:\/\/github\.com\/acme\/shop\/pull\/5\): BUG-7: the token is still in the log/);
  assert.equal(extractTriage(w.gh.issues.get(3).body).reopens.length, 0);
  assert.deepEqual(parseState(w.pr.comments[0].body).countedReviews, [41]);
  const again = syncGate(w.config, w.deps([]));
  assert.deepEqual(again.reopens, [], 'the same review is not counted twice');
  assert.equal(extractTriage(w.gh.issues.get(7).body).reopens.length, 1);
});

test('re-run placement: on the open PR\'s branch, else a follow-up branch from the base', () => {
  const config = { implement: { reviewGate: SETTINGS } };
  assert.ok(isReopened(config, { labels: ['bug', 'reopened'] }));
  assert.ok(isReopened(config, { issue: { labels: ['reopened'] } }));
  const open = placeReopened(config, { branch: 'feat/bug-3-x', worktree: '/w/bug-3' }, { prOf: () => 'https://x/pull/5', exists: () => true });
  assert.deepEqual([open.branch, open.fromRemote, open.reopenedPr], ['feat/bug-3-x', true, 'https://x/pull/5']);
  const merged = placeReopened(config, { branch: 'feat/bug-3-x', worktree: '/w/bug-3' }, { prOf: () => null, exists: (b) => b === 'feat/bug-3-x-r1' });
  assert.deepEqual([merged.branch, merged.worktree, merged.followUp], ['feat/bug-3-x-r2', '/w/bug-3-r2', 2]);
  // A delivered bug epic's group still joins (its PR is open); batching keeps the unit.
  const b = batchesFor(['BUG-3'], { ticketOf: () => ({ epic: 'epic-x' }), epicRunOf: () => ({ status: 'delivered', units: { g: { id: 'g', keys: ['BUG-3'], branch: 'bugfix/x/g' } } }) });
  assert.deepEqual(b, [{ epic: 'epic-x', unit: 'g', keys: ['BUG-3'] }]);
});
