// The story-level nits-and-scope rule: review findings and QE bugs reach the orchestrator with ids, its
// disputes go to the next reviewer round, which accepts or re-asserts them; follow-ups are collected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readJsonl } from '../../pipeline/lib/util.mjs';
import { applyReviewDisputes, readReviewDisputes } from '../../review/lib/review.mjs';
import { newFeedbackLog } from '../lib/feedback.mjs';
import { epicPrBody } from '../lib/epic-plan.mjs';

const tmpConfig = () => ({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-')), stateDir: '.agent-state', metricsDir: '.agent-metrics' });
const review = [
  { severity: 'blocking', issue: 'rename CouponSvc to CouponService', file: 'a.cs' },
  { severity: 'blocking', issue: 'missing owner check on DELETE', file: 'b.cs' },
];

test('review findings get ids; the orchestrator disputes a nit and lists a follow-up; the dispute goes to the next review round', () => {
  const config = tmpConfig();
  const log = newFeedbackLog();
  const text = log.given('architecture-reviewer', review, { round: 1 });
  assert.match(text, /review-r1-1: rename CouponSvc[\s\S]*review-r1-2: missing owner check[\s\S]*"kind": "nit" \| "out-of-scope"/);
  log.afterRun(config, 'DEMO-1', { status: 'done', disputes: [{ finding: 'review-r1-1', kind: 'nit', reason: 'naming does not affect any acceptance criterion' }, { finding: 'nope', kind: 'nit' }], followUps: [{ title: 'Coupon admin page is slow', reason: 'N+1 query' }] }, { round: 2 });
  assert.deepEqual(log.counts(), { nit: 1, outOfScope: 0, total: 1 });
  assert.deepEqual(log.followUps, [{ title: 'Coupon admin page is slow', reason: 'N+1 query', source: 'architecture-reviewer' }]);
  const d = readReviewDisputes(config, 'DEMO-1');
  assert.deepEqual(d.open.map((x) => [x.id, x.kind]), [['review-r1-1', 'nit']]);
  const decisions = readJsonl(path.join(config.root, '.agent-metrics/decisions.jsonl'));
  assert.equal(decisions.at(-1).decision, 'disputed');
  assert.deepEqual(decisions.at(-1).items.map((i) => i.finding), ['review-r1-1']);
});

test('the reviewer rules: raised again without evidence it no longer blocks; re-asserted with evidence twice it stays blocking', () => {
  const config = tmpConfig();
  const log = newFeedbackLog();
  log.given('architecture-reviewer', review.slice(0, 1), { round: 1 });
  log.afterRun(config, 'DEMO-1', { disputes: [{ finding: 'review-r1-1', kind: 'nit', reason: 'style only' }] }, { round: 2 });
  const accepted = applyReviewDisputes(config, 'DEMO-1', { verdict: 'CHANGES_REQUESTED', findings: [{ id: 'review-r1-1', severity: 'blocking', issue: review[0].issue }] });
  assert.equal(accepted.verdict, 'APPROVED');
  assert.equal(accepted.findings[0].severity, 'minor');
  assert.deepEqual(readReviewDisputes(config, 'DEMO-1').open, [], 'ruled disputes are cleared');

  // The same finding raised in later rounds keeps its first id (review-r2-1), so the counts carry over.
  for (let n = 1; n <= 2; n++) {
    assert.match(log.given('architecture-reviewer', review.slice(1), { round: n + 1, config, key: 'DEMO-1' }), /- review-r2-1: missing owner check/);
    log.afterRun(config, 'DEMO-1', { disputes: [{ finding: 'review-r2-1', kind: 'out-of-scope', reason: 'not in the AC' }] }, { round: n + 2 });
    const r = applyReviewDisputes(config, 'DEMO-1', { verdict: 'CHANGES_REQUESTED', findings: [{ id: 'review-r2-1', severity: 'blocking', issue: review[1].issue, evidence: 'AC2: only the owner may delete' }] });
    assert.equal(r.verdict, 'CHANGES_REQUESTED');
    assert.equal(r.rulings[0].ruling, 'reasserted');
  }
  // A third dispute of the finding is overruled: the reviewer is not asked again.
  log.given('architecture-reviewer', review.slice(1), { round: 4, config, key: 'DEMO-1' });
  log.afterRun(config, 'DEMO-1', { disputes: [{ finding: 'review-r2-1', kind: 'out-of-scope', reason: 'still not in the AC' }] }, { round: 5 });
  const d = readReviewDisputes(config, 'DEMO-1');
  assert.equal(d.open.length, 0);
  assert.equal(d.overruled[0].ruling, 'overruled');
  const r = applyReviewDisputes(config, 'DEMO-1', { verdict: 'CHANGES_REQUESTED', findings: [{ id: 'review-r2-1', severity: 'blocking', issue: review[1].issue }] });
  assert.equal(r.verdict, 'CHANGES_REQUESTED', 'an overruled finding stays blocking');
});

test('QE bug disputes are recorded only; no review file is written', () => {
  const config = tmpConfig();
  const log = newFeedbackLog();
  log.given('qe-automation', [{ issue: 'TC-DEMO-1-02: 500 on expired coupon', severity: 'blocking' }], { round: 1 });
  log.afterRun(config, 'DEMO-1', { disputes: [{ finding: 'qe-r1-1', kind: 'out-of-scope', reason: 'expired coupons are DEMO-4' }] }, { round: 3 });
  assert.equal(log.disputes[0].source, 'qe-automation');
  assert.equal(fs.existsSync(path.join(config.root, '.agent-state/review/DEMO-1.disputes.json')), false);
});

test('the epic PR lists the follow-ups the implementers raised', () => {
  const body = epicPrBody({ epic: { key: 'epic-shop' }, branch: 'epic/shop', stories: [], results: {}, followUps: [{ ticket: 'DEMO-1', title: 'Coupon admin page is slow', reason: 'N+1 query' }] });
  assert.match(body, /## Follow-ups \(not in this PR\)\n\n- DEMO-1: Coupon admin page is slow \(N\+1 query\)/);
});
