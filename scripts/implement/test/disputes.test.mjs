// Nits and scope: the implementer disputes, the verifier accepts or re-asserts with evidence, and a
// finding re-asserted twice stays blocking.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_REASSERTS, disputeCounts, formatDisputes, openDisputes, parseImplementerReport, ruleDisputes, withIds } from '../lib/disputes.mjs';

const findings = withIds(
  [
    { severity: 'blocking', file: 'src/A.cs', issue: 'rename x to total' },
    { severity: 'blocking', file: 'src/A.cs', issue: 'also add CSV export' },
  ],
  { subtask: 'api', round: 1 },
);
const verdict = (fs, disputes) => ({ verdict: fs.some((f) => f.severity !== 'minor') ? 'CHANGES_REQUESTED' : 'APPROVED', summary: '', findings: fs, ...(disputes ? { disputes } : {}) });

test('findings get stable ids; disputes match by id or quoted issue; follow-ups are kept', () => {
  assert.deepEqual(findings.map((f) => f.id), ['api-r1-1', 'api-r1-2']);
  assert.equal(withIds([{ id: 'keep', issue: 'x' }], { subtask: 'api', round: 2 })[0].id, 'keep');
  const r = parseImplementerReport(
    {
      disputes: [
        { finding: 'api-r1-1', kind: 'nit', reason: 'AC 1 says nothing about naming' },
        { finding: 'Also add CSV export', kind: 'out-of-scope', reason: 'no AC asks for export' },
        { finding: 'unknown', kind: 'nit' },
        { finding: 'api-r1-1', kind: 'bogus' },
      ],
      followUps: [{ title: 'CSV export of totals', reason: 'admins asked for it' }, { reason: 'no title' }],
    },
    findings,
  );
  assert.deepEqual(r.disputes.map((d) => [d.id, d.kind]), [['api-r1-1', 'nit'], ['api-r1-2', 'out-of-scope']]);
  assert.deepEqual(r.followUps, [{ title: 'CSV export of totals', reason: 'admins asked for it' }]);
});

test('an accepted dispute drops the finding; raised again without evidence it does not block', () => {
  const state = new Map();
  const { open } = openDisputes(parseImplementerReport({ disputes: [{ finding: 'api-r1-1', kind: 'nit', reason: 'naming' }, { finding: 'api-r1-2', kind: 'out-of-scope', reason: 'no AC' }] }, findings).disputes, state);
  assert.match(formatDisputes(open), /- api-r1-1 \(nit\): "rename x to total"\n {2}Implementer: naming/);
  // The verifier accepts one explicitly and raises the other again without evidence.
  const ruled = ruleDisputes(verdict([{ ...findings[1] }], [{ finding: 'api-r1-1', decision: 'accepted' }]), open, state);
  assert.equal(ruled.verdict.verdict, 'APPROVED');
  assert.equal(ruled.verdict.findings[0].severity, 'minor');
  assert.deepEqual(ruled.rulings.map((r) => [r.id, r.ruling]), [['api-r1-1', 'accepted'], ['api-r1-2', 'accepted']]);
  assert.deepEqual(disputeCounts(ruled.rulings, [{ title: 't' }]), { nit: 1, outOfScope: 1, accepted: 2, reasserted: 0, overruled: 0, followUps: 1 });
});

test('a finding re-asserted twice after disputes stays blocking: the third dispute is overruled', () => {
  const state = new Map();
  const target = findings[0];
  const reassert = () => verdict([{ ...target, evidence: 'AC 3: the field is labelled Total in the mockup' }]);
  for (let n = 1; n <= MAX_REASSERTS; n++) {
    const { open, overruled } = openDisputes([{ id: target.id, issue: target.issue, kind: 'nit', reason: 'naming' }], state);
    assert.deepEqual([open.length, overruled.length], [1, 0]);
    const ruled = ruleDisputes(reassert(), open, state, overruled);
    assert.equal(ruled.verdict.verdict, 'CHANGES_REQUESTED');
    assert.equal(ruled.verdict.findings[0].reasserted, n);
    assert.equal(ruled.rulings[0].ruling, 'reasserted');
  }
  const { open, overruled } = openDisputes([{ id: target.id, issue: target.issue, kind: 'nit', reason: 'still naming' }], state);
  assert.deepEqual([open.length, overruled.length], [0, 1]);
  assert.match(formatDisputes(open, overruled), /re-asserted 2 times; the implementer's new dispute is overruled/);
  // Raised again, even without evidence, it stays blocking: there is nothing left to rule on.
  const ruled = ruleDisputes(verdict([{ ...target }]), open, state, overruled);
  assert.equal(ruled.verdict.verdict, 'CHANGES_REQUESTED');
  assert.deepEqual(ruled.rulings.map((r) => r.ruling), ['overruled']);
});

test("follow-ups are collected into the story's run record", async () => {
  const { storyOutcomeRecord } = await import('../lib/decisions.mjs');
  const followUps = [{ title: 'Rename legacy totals', reason: 'confusing', subtask: 'api', round: 2 }];
  assert.deepEqual(storyOutcomeRecord({ ts: 't', key: 'DEMO-1', outcome: 'done', wallClockSec: 1, followUps }).followUps, followUps);
  assert.deepEqual(storyOutcomeRecord({ ts: 't', key: 'DEMO-1', outcome: 'done', wallClockSec: 1 }).followUps, []);
});
