// Review gate, step 5: pr-review records when a gated PR closes, outcomes joined later, and the retro's
// review section with its guarded approvals proposals.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readJsonl } from '../../pipeline/lib/util.mjs';
import { retroDigest, digestIsEmpty } from '../../qe/lib/retro.mjs';
import { encodeState } from '../lib/gate.mjs';
import { outcomeFor, prReviewRecord, reviewersOf, revertsOf, substantive } from '../lib/pr-review.mjs';
import { applyProposals, proposeApprovals, reviewDigest } from '../lib/review-retro.mjs';
import { syncGate } from '../lib/sync.mjs';
import { upsertTriage } from '../lib/triage-section.mjs';
import { fakeGh } from './fake-gh.mjs';
import { gateConfigFor } from './helpers.mjs';

const review = (login, state, at, body = '', id = Math.random()) => ({ id, user: { login }, state, submitted_at: at, body, commit_id: 'h' });
const comment = (login, at, pathName, body) => ({ user: { login }, created_at: at, path: pathName, body });
const commit = (at, login = 'armando') => ({ sha: at, commit: { committer: { date: at } }, author: { login } });

test('reviewers: order, verdict sequence, substantive comments, commits that followed, and who found something new', () => {
  assert.ok(substantive('The token is still written to the log here.'));
  assert.ok(!substantive('LGTM, looks good to me overall!!'));
  assert.ok(!substantive('ok'));
  const reviews = [review('ann', 'CHANGES_REQUESTED', '2026-11-01T10:00:00Z', 'The retry loop never stops on a 401 response.'), review('ann', 'APPROVED', '2026-11-01T14:00:00Z'), review('bob', 'APPROVED', '2026-11-01T11:00:00Z', 'lgtm'), review('cy', 'COMMENTED', '2026-11-01T12:00:00Z')];
  const comments = [comment('bob', '2026-11-01T11:00:00Z', 'src/A.cs', 'Same file ann flagged; agree with her point here.'), comment('cy', '2026-11-01T12:00:00Z', 'src/B.cs', 'This cache key ignores the buyer id entirely.'), comment('ann', '2026-11-01T10:00:00Z', 'src/A.cs', 'Retry loop: add a cap on attempts here.')];
  const rs = reviewersOf({ reviews, comments, commits: [commit('2026-11-01T13:00:00Z')], author: 'armando' });
  assert.deepEqual(rs.map((r) => [r.login, r.order, r.verdicts.join('>'), r.substantiveComments, r.ledToCommits, r.foundNew]), [
    ['ann', 1, 'CHANGES_REQUESTED>APPROVED', 2, true, true],
    ['bob', 2, 'APPROVED', 1, true, false],
    ['cy', 3, '', 1, true, true],
  ]);
});

test('a pr-review record holds the class features, the review and the outcome known at close', () => {
  const view = { url: 'https://github.com/acme/shop/pull/5', number: 5, state: 'MERGED', author: 'armando', createdAt: '2026-11-01T09:00:00Z', mergedAt: '2026-11-01T15:00:00Z', additions: 40, deletions: 5, changedFiles: 3, mergeCommit: { oid: 'm1' } };
  const state = { action: 'review', approvals: 1, class: 'High+shared', severity: 'High', systems: { names: ['Identity.API', 'EventBus'], shared: true }, tickets: [{ key: 'BUG-7', issue: 7, severity: 'High' }] };
  const triages = [{ key: 'BUG-7', impact: 'Medium', complexity: 'Low', fixRisk: 'Low', severity: { level: 'High' }, confidence: { score: 72, high: false }, floorReasons: ['src/Identity.API/**', 'category auth'], reopens: [{ source: 'changes-requested', afterMerge: false }] }];
  const r = prReviewRecord({ ts: 't', view, state, triages, reviews: [review('ann', 'APPROVED', '2026-11-01T10:30:00Z')], commits: [commit('2026-11-01T08:00:00Z'), commit('2026-11-01T12:00:00Z', 'ann')] });
  assert.equal(r.type, 'pr-review');
  assert.deepEqual([r.class, r.ticketCount, r.systemCount, r.shared, r.confidence, r.requiredApprovals, r.approvals], ['High+shared', 1, 2, true, 72, 1, 1]);
  assert.deepEqual(r.overridePaths, ['src/Identity.API/**']);
  assert.deepEqual(r.diff, { additions: 40, deletions: 5, files: 3 });
  assert.deepEqual([r.timeToFirstReviewMin, r.timeToMergeMin, r.commitsAfterOpen, r.humanCommits], [90, 360, 1, 1]);
  assert.equal(r.tickets[0].reopensBeforeMerge, 1);
  // Outcomes are joined later: reopens after merge, follow-up bugs (late records) and reverts.
  const later = [{ type: 'reopen', story: 'BUG-7', afterMerge: true, ts: '2026-11-03' }, { type: 'late', story: 'BUG-7', bugStories: ['BUG-12'] }, { type: 'revert', pr: r.pr }];
  assert.deepEqual(outcomeFor(r, later), { reopensAfterMerge: 1, followUpBugs: ['BUG-12'], reverts: 1, escaped: true });
  assert.deepEqual(outcomeFor(r, []).escaped, false);
  assert.equal(revertsOf(r, [{ sha: 'x', subject: 'Revert "Fix"', body: 'This reverts commit m1.' }, { sha: 'y', subject: 'other', body: '' }]).length, 1);
});

const rec = (n, cls, { approvals = 1, reviewers = [], merged = true, auto = false, escaped = false } = {}) => [
  { type: 'pr-review', pr: `p${n}`, class: cls, severity: cls.replace(/\+shared$/, ''), stories: [`BUG-${n}`], merged, approvals, gate: { autoMerged: auto }, reviewers: reviewers.map((foundNew, i) => ({ order: i + 1, foundNew })), timeToFirstReviewMin: 10 * (reviewers.length || 1), timeToMergeMin: 60 * (reviewers.length || 1), mergedAt: '2026-11-01' },
  ...(escaped ? [{ type: 'reopen', story: `BUG-${n}`, afterMerge: true, ts: '2026-11-05' }] : []),
];

test('review digest: per class, the 2nd and 3rd reviewers\' find rate, escapes by approvals, latency per reviewer count', () => {
  const records = [...rec(1, 'Medium', { reviewers: [true, true] }), ...rec(2, 'Medium', { reviewers: [true, false] }), ...rec(3, 'Medium', { reviewers: [false], escaped: true }), ...rec(4, 'Low', { approvals: 0, auto: true })];
  const d = reviewDigest(records, { table: { default: 1 } });
  const medium = d.classes.find((c) => c.class === 'Medium');
  assert.equal(medium.prs, 3);
  assert.deepEqual(medium.secondReviewerFound, { prs: 2, foundNew: 1, rate: 0.5 });
  assert.deepEqual(medium.thirdReviewerFound, { prs: 0, foundNew: 0, rate: null });
  assert.deepEqual(medium.escapesByApprovals, { 1: { prs: 3, escapes: 1, rate: 0.33 } });
  assert.deepEqual(medium.latencyByReviewers[2], { prs: 2, medianFirstReviewMin: 20, medianMergeMin: 120 });
  assert.equal(d.classes.find((c) => c.class === 'Low').autoMerged, 1);
  assert.deepEqual(d.proposals, [], 'no class has the minimum sample yet');
});

test('approvals proposals: a minimum sample, never below 1, widening auto-merge only in writing', () => {
  const many = (cls, n, opts) => Array.from({ length: n }, (_, i) => rec(`${cls}${i}`, cls, typeof opts === 'function' ? opts(i) : opts)).flat();
  const raise = reviewDigest(many('High', 5, { reviewers: [true, true] }), { table: { default: 1 } });
  assert.deepEqual(raise.proposals.map((p) => [p.class, p.kind, p.from, p.to]), [['High', 'approvals', 1, 2]]);
  assert.match(raise.proposals[0].why, /reviewer 2 found something the earlier ones didn't in 100%/);
  assert.deepEqual(reviewDigest(many('High', 4, { reviewers: [true, true] }), { table: { default: 1 } }).proposals, [], '4 PRs is below the sample');
  const escapes = reviewDigest(many('Medium', 5, (i) => ({ reviewers: [true], escaped: i < 2 })), { table: { default: 1 } });
  assert.match(escapes.proposals[0].why, /40% of 5 merged Medium PRs with 1 approval\(s\) escaped/);
  const lower = reviewDigest(many('Severe', 6, { approvals: 2, reviewers: [true, false] }), { table: { Severe: 2 } });
  assert.deepEqual(lower.proposals.map((p) => [p.from, p.to]), [[2, 1]]);
  const widen = reviewDigest(many('Medium', 5, { reviewers: [false] }), { table: { default: 1 } });
  assert.deepEqual(widen.proposals.map((p) => [p.kind, p.to]), [['widen-auto-merge', null]]);
  assert.deepEqual(applyProposals({ default: 1 }, widen.proposals), { default: 1 }, 'never applied');
  // Never fewer than 1 approval, whatever a proposal says.
  assert.deepEqual(proposeApprovals([{ class: 'High', prs: 9, autoMerged: 0, requiredApprovals: 1, firstReviewerFound: { prs: 9, rate: 0 }, secondReviewerFound: { prs: 0 }, thirdReviewerFound: { prs: 0 }, escapes: 0, escapesByApprovals: {} }], {}).filter((p) => p.kind === 'approvals'), []);
  assert.deepEqual(applyProposals({ Low: 1 }, [{ kind: 'approvals', class: 'Low', to: 0 }]), { Low: 1 });
});

test('the factory retro carries the review section; new pr-review records make the retro due', () => {
  const outcomes = rec(1, 'Medium', { reviewers: [true] });
  const digest = retroDigest({ lessons: { examplesPerCategory: 5 } }, [], '2026-01-01', { outcomes: outcomes.map((r) => ({ ...r, ts: '2026-11-02' })), policy: { table: { default: 1 } } });
  assert.equal(digest.reviews.prs, 1);
  assert.equal(digest.newPrReviews, 1);
  assert.equal(digestIsEmpty(digest), false);
  assert.equal(digestIsEmpty(retroDigest({ lessons: { examplesPerCategory: 5 } }, [], '2026-01-01')), true);
});

test('board sync records each closed gated PR once, and a revert of its merge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-rec-'));
  const gh = fakeGh();
  const pr = gh.addPr(9, { state: 'MERGED', mergedAt: '2026-11-02T00:00:00Z', labels: ['approvals:1', 'needs-human'], author: 'armando', mergeCommit: { oid: 'merge9' }, reviews: [review('ann', 'APPROVED', '2026-11-01T12:00:00Z', 'Checked the redirect allow-list carefully.')] });
  pr.comments.push({ id: 5, body: encodeState({ action: 'review', approvals: 1, class: 'Medium', severity: 'Medium', systems: { names: ['Identity.API'] }, tickets: [{ key: 'BUG-9', issue: 9 }] }) });
  gh.addIssue(9, { body: upsertTriage('story', { key: 'BUG-9', impact: 'Medium', severity: { level: 'Medium' }, confidence: { score: 70 }, reopens: [] }) });
  gh.addPr(10, { state: 'MERGED', labels: [] });
  const config = gateConfigFor(root);
  const deps = { gh: gh.gh, items: [], metricsConfig: config, markerOf: () => null, baseLog: () => [{ sha: 'r1', subject: 'Revert "Fix 9"', body: 'This reverts commit merge9.' }] };
  const first = syncGate(config, deps);
  assert.deepEqual(first.reviews, [pr.url]);
  syncGate(config, deps);
  const recs = readJsonl(path.join(root, '.agent-metrics/decision-outcomes.jsonl'));
  assert.deepEqual(recs.map((r) => r.type), ['pr-review', 'revert']);
  assert.deepEqual([recs[0].class, recs[0].approvals, recs[0].reviewers[0].login, recs[0].reviewers[0].substantiveComments], ['Medium', 1, 'ann', 1]);
  assert.deepEqual(recs[1].commits, ['r1']);
});
