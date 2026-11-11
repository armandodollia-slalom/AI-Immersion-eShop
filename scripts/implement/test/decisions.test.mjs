// The decision log: record shapes, escaped-defect attribution by owns, and the labeling rules.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptanceCount, attributeEscaped, decisionRecord, formatDecisionReport, labelDecisions, roundRecord, storyOutcomeRecord, subtaskRunRecord } from '../lib/decisions.mjs';
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
  assert.deepEqual(round, { round: 1, verdict: 'CHANGES_REQUESTED', findings: { 'blocking/correctness': 1, 'minor/fit': 1 }, diagnostics: { errors: 1, warnings: 2 }, outOfOwnsEdits: 1, crossSubtaskFindings: 1 });
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
