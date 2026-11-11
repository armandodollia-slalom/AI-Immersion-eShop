// The decision log: record shapes, escaped-defect attribution by owns, and the labeling rules.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptanceCount, attributeEscaped, decisionRecord, formatDecisionReport, labelDecisions, planDecisionLog, planDecisions, prCheckDesignFindings, roundRecord, storyOutcomeRecord, subtaskRunRecord, verdictDecisionLog } from '../lib/decisions.mjs';
import { decisionRecord as sharedRecord } from '../../pipeline/lib/decisions.mjs';
import { validatePlan } from '../lib/plan.mjs';

const story = '# DEMO-1: [BE - Catalog.API, Basket.API] - X\n\n## Acceptance Criteria\n\n- one\n- two\n- three\n\n## Technical Notes\n\n- not an AC\n';
const sub = (id, owns, over = {}) => ({ id, goal: id, acceptance: ['x'], owns, dependsOn: [], modelClass: 'medium', verify: 'code', modelReason: 'normal', verifyReason: 'api', expectedFiles: 2, expectedLoc: 40, confidence: 0.7, alternatives: [{ option: 'self', reason: 'two services' }], ...over });

test('acceptance criteria are counted from their section only', () => {
  assert.equal(acceptanceCount(story), 3);
  assert.equal(acceptanceCount('# X\n\nno section'), null);
});

test('a decision record carries the plan, its reasons and the story features', () => {
  const v = validatePlan({ mode: 'delegate', modeReason: 'two services', splitReason: 'per service', features: { estimatedSize: 'medium' }, subtasks: [sub('api', ['src/Catalog.API/**']), sub('basket', ['src/Basket.API/**'])] }, { storyText: story });
  const r = decisionRecord({ ts: 't', key: 'DEMO-1', decisionId: 'd1', attempt: 1, accepted: true, agent: { cli: 'claude', model: 'o', version: 'v1' }, plan: v.plan, storyText: story });
  assert.equal(r.decisionId, 'd1');
  assert.deepEqual(r.orchestrator, { cli: 'claude', model: 'o', promptVersion: 'v1' });
  assert.equal(r.modeReason, 'two services');
  assert.deepEqual(r.features, { services: ['Basket.API', 'Catalog.API'], acceptanceCriteria: 3, uiStory: false, estimatedSize: 'medium' });
  assert.deepEqual(Object.keys(r.subtasks[0]).sort(), ['alternatives', 'confidence', 'dependsOn', 'expectedFiles', 'expectedLoc', 'goal', 'id', 'modelClass', 'modelReason', 'owns', 'verify', 'verifyReason']);
  const rejected = decisionRecord({ ts: 't', key: 'DEMO-1', decisionId: null, attempt: 2, accepted: false, errors: ['bad'], raw: { mode: 'delegate', subtasks: [{ id: 'x' }] }, storyText: story });
  assert.equal(rejected.decisionId, null);
  assert.deepEqual(rejected.rejectionReasons, ['bad']);
  assert.equal(rejected.subtasks[0].id, 'x');
});

test('subtask runs record counts, not finding text', () => {
  const round = roundRecord({ round: 1, verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'blocking', category: 'correctness', issue: 'secret' }, { severity: 'minor', category: 'fit' }], diagnostics: { available: true, errors: [1], warnings: [1, 2] }, outOfOwns: ['x'], crossFindings: 1 });
  assert.deepEqual(round, { round: 1, verdict: 'CHANGES_REQUESTED', findings: { 'blocking/correctness': 1, 'minor/fit': 1 }, designFindings: 0, diagnostics: { errors: 1, warnings: 2 }, outOfOwnsEdits: 1, crossSubtaskFindings: 1 });
  const r = subtaskRunRecord({ ts: 't', key: 'K', decisionId: 'd', subtaskId: 'api', maxRounds: 3, rounds: [round], approved: true });
  assert.equal(r.escalation, 'none');
  assert.equal(r.tokens, null);
  assert.deepEqual(r.actual, { files: null, loc: null });
  assert.equal(storyOutcomeRecord({ ts: 't', key: 'K', outcome: 'done', wallClockSec: 5 }).type, 'story');
});

test('escaped defects are credited to the subtask that owns the file', () => {
  const subtasks = [{ id: 'api', owns: ['src/Catalog.API/**'] }, { id: 'basket', owns: ['src/Basket.API/**'] }];
  const recs = attributeEscaped({ ts: 't', key: 'K', decisionId: 'd', subtasks, source: 'arch-review', findings: [{ severity: 'blocking', file: 'src/Basket.API/A.cs', issue: 'x' }, { severity: 'blocking', file: 'docs/x.md', issue: 'y' }], files: ['src/Catalog.API/B.cs'] });
  const by = Object.fromEntries(recs.map((r) => [String(r.subtaskId), r]));
  assert.equal(by.basket.findings[0].file, 'src/Basket.API/A.cs');
  assert.deepEqual(by.api.files, ['src/Catalog.API/B.cs']);
  assert.equal(by.null.findings[0].file, 'docs/x.md', 'unowned files are kept, unattributed');
  assert.ok(recs.every((r) => r.type === 'escaped' && r.source === 'arch-review' && r.decisionId === 'd'));
  const self = attributeEscaped({ ts: 't', key: 'K', decisionId: 'd', subtasks: [{ id: 'self', owns: ['**'], self: true }], source: 'qe', findings: [{ issue: 'bug' }], files: ['src/A.cs'] });
  assert.deepEqual(self.map((r) => r.subtaskId).sort(), ['self', null].sort((a, b) => String(a).localeCompare(String(b))));
});

test('labels: over/under-provisioned, bad split, should-have-been-self, weak verification', () => {
  const decisions = [
    { story: 'K', decisionId: 'd1', accepted: true, mode: 'delegate', subtasks: [{ id: 'a', modelClass: 'large' }, { id: 'b', modelClass: 'small' }, { id: 'c', modelClass: 'medium' }] },
    { story: 'L', decisionId: 'd2', accepted: true, mode: 'delegate', subtasks: [{ id: 'x', modelClass: 'small' }, { id: 'y', modelClass: 'small' }] },
    { story: 'L', decisionId: null, accepted: false, mode: 'delegate', subtasks: [] },
  ];
  const run = (decisionId, subtaskId, over) => ({ decisionId, subtaskId, maxRounds: 3, rounds: [{ verdict: 'APPROVED' }], approved: true, escalation: 'none', mergeConflictFiles: [], filesNeededOutsideOwns: [], actual: { files: 1, loc: 20 }, agentRuns: 2, ...over });
  const runs = [
    run('d1', 'a', {}),
    run('d1', 'b', { rounds: [{}, {}, {}], escalation: 'takeover' }),
    run('d1', 'c', { mergeConflictFiles: ['src/x.cs'], actual: { files: 9, loc: 400 } }),
    run('d2', 'x', { agentRuns: 4 }),
    run('d2', 'y', { agentRuns: 3 }),
  ];
  const outcomes = [{ type: 'escaped', decisionId: 'd1', subtaskId: 'c' }, { type: 'story', decisionId: 'd1', outcome: 'done' }];
  const rows = labelDecisions({ decisions, runs, outcomes });
  const labels = Object.fromEntries(rows.map((r) => [`${r.decisionId}/${r.subtaskId}`, r.labels]));
  assert.deepEqual(labels['d1/a'], ['over-provisioned']);
  assert.deepEqual(labels['d1/b'], ['under-provisioned']);
  assert.deepEqual(labels['d1/c'], ['bad-split', 'weak-verification']);
  assert.deepEqual(labels['d2/(plan)'], ['should-have-been-self']);
  assert.equal(rows.find((r) => r.subtaskId === 'a').outcome, 'done');
  assert.deepEqual(labelDecisions({ decisions, runs, outcomes }, { selfOverheadRunsPerSubtask: 10 }).filter((r) => r.subtaskId === '(plan)'), [], 'thresholds come from config');
  assert.match(formatDecisionReport(rows), /over-provisioned: 1 +under-provisioned: 1 +bad-split: 1 +should-have-been-self: 1 +weak-verification: 1/);
});

test('late outcomes: human commits are the ones the pipeline did not make; BUG stories naming the key', async () => {
  const { bugStoriesFor, humanCommitStats, lateOutcomeRecord } = await import('../lib/decisions.mjs');
  const commits = [{ oid: 'a', lines: 10, authors: ['bot'] }, { oid: 'b', lines: 4, authors: ['alice'] }, { oid: 'c', lines: 2, authors: ['bob'] }];
  const stats = humanCommitStats(commits, { isPipeline: (c) => c.oid === 'a' });
  assert.deepEqual(stats, { humanCommits: 2, humanLines: 6, humanAuthors: ['alice', 'bob'] });
  assert.equal(humanCommitStats([{ oid: 'x', lines: null }], { isPipeline: () => false }).humanLines, null);
  const stories = [{ key: 'BUG-3', text: 'Regression from PROMO-3 checkout' }, { key: 'BUG-4', text: 'PROMO-30 thing' }, { key: 'PROMO-4', text: 'PROMO-3' }];
  assert.deepEqual(bugStoriesFor('PROMO-3', stories), ['BUG-3']);
  const rec = lateOutcomeRecord({ ts: 't', key: 'PROMO-3', decisionId: 'd', pr: 'u', prMerged: true, stats, bugStories: ['BUG-3'] });
  assert.deepEqual([rec.type, rec.prMerged, rec.humanCommits, rec.reverts], ['late', true, 2, null]);
});

test('plan attempts and pair verdicts go to the shared decision log, and the labels read them back', () => {
  const v = validatePlan({ mode: 'delegate', modeReason: 'two services', splitReason: 'by service', subtasks: [sub('api', ['src/Catalog.API/**']), sub('basket', ['src/Basket.API/**'])] }, { storyText: story });
  const rec = decisionRecord({ ts: 't', key: 'DEMO-1', decisionId: 'd-1', attempt: 1, accepted: true, agent: { cli: 'claude', model: 'opus', version: 'v1' }, plan: v.plan, storyText: story });
  const entry = sharedRecord(planDecisionLog(rec));
  assert.deepEqual([entry.stage, entry.decision, entry.decision_id, entry.round, entry.agent, entry.reason], ['implement-plan', 'plan-written', 'd-1', 1, 'implementer', 'two services / by service']);
  assert.deepEqual(entry.items.map((i) => [i.id, i.modelClass, i.modelReason, i.verifyReason, i.alternatives.length]), [['api', 'medium', 'normal', 'api', 1], ['basket', 'medium', 'normal', 'api', 1]]);
  const rejected = sharedRecord(planDecisionLog(decisionRecord({ ts: 't', key: 'DEMO-1', attempt: 1, accepted: false, errors: ['a', 'b'], agent: {}, raw: { mode: 'delegate', subtasks: [] } })));
  assert.deepEqual([rejected.decision, rejected.decision_id, rejected.reason], ['plan-rejected', null, 'a; b']);
  assert.deepEqual(planDecisions([entry, rejected, { stage: 'review', decision: 'approved' }]).map((d) => [d.accepted, d.decisionId, d.subtasks.length]), [[true, 'd-1', 2], [false, null, 0]]);
  const rows = labelDecisions({ decisions: [entry], runs: [subtaskRunRecord({ key: 'DEMO-1', decisionId: 'd-1', subtaskId: 'api', approved: true, rounds: [roundRecord({ round: 1, verdict: 'APPROVED' })], actual: { files: 1, loc: 10 } })] });
  assert.deepEqual(rows.find((r) => r.subtaskId === 'api').labels, ['over-provisioned']);

  const verdict = sharedRecord(verdictDecisionLog({ key: 'DEMO-1', decisionId: 'd-1', st: { id: 'api' }, round: 2, verdict: { verdict: 'CHANGES_REQUESTED', summary: 'missing check', findings: [{ severity: 'blocking', category: 'logic', file: 'src/Catalog.API/A.cs', line: 3, issue: 'no owner check', fix: 'add it' }] }, verifier: { version: 'v9' } }));
  assert.deepEqual([verdict.stage, verdict.agent, verdict.subject, verdict.decision, verdict.subtask, verdict.agent_ver], ['implement-verify', 'pair-verifier', 'pair-implementer', 'changes-requested', 'api', 'v9']);
  assert.deepEqual(verdict.items[0], { severity: 'blocking', category: 'logic', file: 'src/Catalog.API/A.cs', line: 3, screenshot: null, reason: 'no owner check', fix: 'add it' });
});

test('subtask and story records carry tokens, cost and premium requests summed from their runs', () => {
  const usage = { runs: 3, measured: 3, unpriced: 0, tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4, total: 10 }, costUsd: 0.42, premiumRequests: 16, nanoAiu: 42e9 };
  const run = subtaskRunRecord({ key: 'DEMO-1', decisionId: 'd', subtaskId: 'api', usage });
  assert.deepEqual([run.tokens, run.cost, run.premiumRequests], [10, 0.42, 16]);
  const story = storyOutcomeRecord({ ts: 't', key: 'DEMO-1', outcome: 'done', wallClockSec: 1, usage: null });
  assert.deepEqual([story.tokens, story.cost, story.premiumRequests], [null, null, null]);
});

test('design findings: counted per UI round, in the decision log with both screenshots, and set against the PR check', () => {
  const findings = [
    { severity: 'blocking', category: 'design', screenshot: '/a/actual-Main.png', mockup: '/a/mockup/Main.png', actual: '/a/actual-Main.png', issue: 'label says Save, mockup says Save draft' },
    { severity: 'minor', category: 'design', screenshot: '/a/actual-Main.png', actual: '/a/actual-Main.png', mockup: '/a/mockup/Main.png', issue: 'tab spacing' },
    { severity: 'blocking', category: 'acceptance', screenshot: '/a/x.png', issue: 'no total' },
  ];
  const r1 = roundRecord({ round: 1, verdict: 'CHANGES_REQUESTED', findings });
  const r2 = roundRecord({ round: 2, verdict: 'APPROVED', findings: [] });
  assert.deepEqual([r1.designFindings, r2.designFindings], [2, 0]);
  const run = subtaskRunRecord({ key: 'DEMO-1', decisionId: 'd', subtaskId: 'web', rounds: [r1, r2], approved: true, verify: 'ui' });
  assert.equal(run.designFindings, 2);

  const entry = sharedRecord(verdictDecisionLog({ key: 'DEMO-1', decisionId: 'd', st: { id: 'web' }, round: 1, verdict: { verdict: 'CHANGES_REQUESTED', findings }, ui: true }));
  assert.equal(entry.design_findings, 2);
  assert.deepEqual([entry.items[0].mockup, entry.items[0].actual], ['/a/mockup/Main.png', '/a/actual-Main.png']);
  assert.equal(entry.items[2].mockup, undefined, 'only design findings carry the mockup pair');

  // The PR check: each upheld design finding once per check (repeats are the same finding); an epic check
  // credits the ticket a finding names, else every ticket it covered.
  const prChecks = [
    { target: 'DEMO-1', story: 'DEMO-1', upheld: [{ id: 'design-1', lens: 'design', title: 'Wrong label' }, { id: 'style-1', lens: 'style', title: 'x' }] },
    { target: 'DEMO-1', story: 'DEMO-1', upheld: [{ id: 'design-1', lens: 'design', title: 'Wrong label', repeat: true }] },
    { target: 'epic-x', story: 'DEMO-1', stories: ['DEMO-1', 'DEMO-2'], upheld: [{ id: 'design-1', lens: 'design', title: 'DEMO-2 empty state missing' }, { id: 'design-2', lens: 'design', title: 'Journey breaks between pages' }] },
  ];
  assert.deepEqual(Object.fromEntries(prCheckDesignFindings(prChecks)), { 'DEMO-1': 2, 'DEMO-2': 2 });

  const decisions = [{ story: 'DEMO-1', decisionId: 'd', accepted: true, mode: 'delegate', subtasks: [{ id: 'web', modelClass: 'medium', verify: 'ui' }] }];
  const rows = labelDecisions({ decisions, runs: [{ ...run, actual: { files: 5, loc: 200 }, escalation: 'none', maxRounds: 3 }], outcomes: [], prChecks });
  assert.deepEqual([rows[0].designFindings, rows[0].prCheckDesignFindings], [2, 2]);
  const report = formatDecisionReport(rows);
  assert.match(report, /Design e\/pr/);
  assert.match(report, /design findings caught early \(UI verifier rounds\): 2 +at PR check \(upheld\): 2/);
});
