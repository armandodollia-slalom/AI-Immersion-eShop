// Review gate, step 2: the decision (auto-merge, wait, review), the review notice, labels, reviewer
// requests and the review-quorum check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalsFor, decideGate, parseState, renderNotice, reviewersFor, gateState } from '../lib/gate.mjs';
import { publishGate } from '../lib/publish.mjs';
import { quorum, requiredApprovals } from '../lib/quorum.mjs';
import { parseCodeowners } from '../lib/systems.mjs';
import { fakeGh } from './fake-gh.mjs';
import { SETTINGS, cacheTicket, cleanMetrics, fakeTriage, fixRepo, gateConfigFor, low, write, git } from './helpers.mjs';

const high = { score: 98, high: true, criteria: {}, reasons: [] };
const ticket = (key, level, extra = {}) => ({ key, issue: { number: Number(key.split('-')[1]) }, impact: level, complexity: 'Low', fixRisk: 'Low', severity: { level, explanation: `Impact ${level}, Fix risk Low → ${level}` }, confidence: high, reopens: [], systems: ['Basket.API'], paths: ['src/Basket.API/A.cs'], ...extra });
const assessment = (tickets, extra = {}) => ({ pr: 'https://github.com/acme/shop/pull/5', tickets, severity: { level: tickets.map((t) => t.severity.level).includes('Medium') ? 'Medium' : 'Low', explanation: 'max ticket severity' }, class: 'Low', systems: { names: ['Basket.API'] }, ci: 'success', headSha: 'h1', ...extra });
const on = { enabled: true, identity: 'gh-user' };

test('decide: Low, high confidence, no reopens and green checks auto-merge (only when switched on)', () => {
  const a = assessment([ticket('BUG-3', 'Low'), ticket('BUG-9', 'Low')]);
  assert.equal(decideGate(a, { settings: SETTINGS, autoMerge: on }).action, 'auto-merge');
  const off = decideGate(a, { settings: SETTINGS, autoMerge: { enabled: false } });
  assert.equal(off.action, 'review');
  assert.equal(off.approvals, 1);
  assert.match(off.triggers[0], /auto-merge is switched off/);
  assert.equal(decideGate({ ...a, ci: 'pending' }, { settings: SETTINGS, autoMerge: on }).action, 'wait');
  assert.equal(decideGate({ ...a, ci: null }, { settings: SETTINGS, autoMerge: on }).action, 'wait');
});

test('decide: says exactly what triggered review and which tickets would have auto-merged', () => {
  const a = assessment([ticket('BUG-3', 'Low'), ticket('BUG-7', 'Medium', { systems: ['Identity.API'] }), ticket('BUG-9', 'Low')], { class: 'Medium' });
  const d = decideGate(a, { settings: SETTINGS, autoMerge: on });
  assert.equal(d.action, 'review');
  assert.equal(d.approvals, 1);
  assert.deepEqual(d.wouldAutoMerge, ['BUG-3', 'BUG-9']);
  assert.match(d.triggers.join(), /^BUG-7 is Medium \(Identity\.API;/);
  const notice = renderNotice(a, d, gateState(a, d));
  assert.match(notice, /BUG-3 and BUG-9 would have auto-merged/);
  assert.match(notice, /## Review gate: 1 approval required/);
  assert.equal(parseState(notice).required, true);
});

test('decide: low confidence, a human reopen, failing checks and PR-level severity each trigger review', () => {
  const lowConf = ticket('BUG-3', 'Low', { confidence: { score: 50, high: false, reasons: ['QE first try unmet', 'CI pending'] } });
  assert.match(decideGate(assessment([lowConf]), { settings: SETTINGS, autoMerge: on }).triggers.join(), /BUG-3 has confidence 50 \(QE first try unmet\)/);
  // Pending CI alone is not low confidence: the PR waits.
  const pending = ticket('BUG-3', 'Low', { confidence: { score: 90, high: false, reasons: ['CI pending'] } });
  assert.equal(decideGate(assessment([pending], { ci: 'pending' }), { settings: SETTINGS, autoMerge: on }).action, 'wait');
  const reopened = ticket('BUG-3', 'Low', { reopens: [{ at: 'x', source: 'card' }] });
  assert.match(decideGate(assessment([reopened]), { settings: SETTINGS, autoMerge: on }).triggers.join(), /BUG-3 has 1 human reopen/);
  assert.match(decideGate(assessment([ticket('BUG-3', 'Low')], { ci: 'failure' }), { settings: SETTINGS, autoMerge: on }).triggers.join(), /checks are failing/);
  const many = assessment([ticket('BUG-3', 'Low')], { severity: { level: 'Medium', explanation: 'max ticket severity Low, +1 for 3 systems → Medium', bumped: true }, class: 'Medium' });
  assert.match(decideGate(many, { settings: SETTINGS, autoMerge: on }).triggers.join(), /the PR is Medium: .*3 systems/);
  const unassessed = ticket('BUG-3', null, { severity: { level: null } });
  assert.match(decideGate(assessment([unassessed], { errors: ['no AGENT_RESULT line'] }), { settings: SETTINGS, autoMerge: on }).triggers.join(), /BUG-3 was not assessed \(no AGENT_RESULT line\)/);
});

test('decide: review is sticky once people were asked; a push while waiting sends the PR to review', () => {
  const a = assessment([ticket('BUG-3', 'Low')]);
  assert.equal(decideGate(a, { settings: SETTINGS, autoMerge: on, prior: { required: true, triggers: ['BUG-3 was Medium'] } }).action, 'review');
  const pushed = decideGate({ ...a, headSha: 'h2' }, { settings: SETTINGS, autoMerge: on, prior: { action: 'wait', headSha: 'h1' } });
  assert.equal(pushed.action, 'review');
  assert.match(pushed.triggers.join(), /changed after it was assessed/);
});

test('approvals: the policy table by class, then severity, then default; never below 1', () => {
  assert.equal(approvalsFor({ default: 1, High: 2, 'High+shared': 3 }, { cls: 'High+shared', severity: 'High' }), 3);
  assert.equal(approvalsFor({ default: 1, High: 2 }, { cls: 'High+shared', severity: 'High' }), 2);
  assert.equal(approvalsFor({ default: 2 }, { cls: 'Medium', severity: 'Medium' }), 2);
  assert.equal(approvalsFor({ Low: 0 }, { cls: 'Low', severity: 'Low' }), 1);
});

test('reviewers: the tickets\' assignees, else the CODEOWNERS of their files; never the author', () => {
  const a = assessment([ticket('BUG-3', 'Low'), ticket('BUG-7', 'Medium', { paths: ['src/Identity.API/P.cs'] })]);
  const codeowners = parseCodeowners('* @armando @landon\nsrc/Identity.API/ @sec\n');
  assert.deepEqual(reviewersFor(a, { assignees: { 'BUG-3': ['dana'], 'BUG-7': [] }, codeowners, author: 'pipeline-bot' }), ['dana', 'sec']);
  assert.deepEqual(reviewersFor(a, { assignees: {}, codeowners, author: 'armando' }), ['landon', 'sec']);
});

test('quorum: distinct approvals on the head commit reach approvals:N; stale, author and bot reviews do not count', () => {
  const r = (login, state, commit, at, type = 'User') => ({ user: { login, type }, state, commit_id: commit, submitted_at: at });
  assert.equal(requiredApprovals(['bug', 'approvals:2', 'approvals:1']), 2);
  assert.equal(requiredApprovals([{ name: 'x' }]), null);
  const reviews = [r('ann', 'APPROVED', 'old', '1'), r('bob', 'APPROVED', 'head', '2'), r('bob', 'COMMENTED', 'head', '3'), r('me', 'APPROVED', 'head', '4'), r('bot', 'APPROVED', 'head', '5', 'Bot')];
  const one = quorum({ labels: [{ name: 'approvals:1' }], reviews, author: 'me', headSha: 'head' });
  assert.equal(one.pass, true);
  assert.deepEqual(one.approvers, ['bob']);
  assert.deepEqual(one.stale, ['ann']);
  const two = quorum({ labels: ['approvals:2'], reviews, author: 'me', headSha: 'head' });
  assert.equal(two.pass, false);
  assert.match(two.summary, /1 of 2 required approval\(s\).*stale, from before the latest push: ann/);
  // A later "changes requested" replaces that reviewer's approval.
  assert.equal(quorum({ labels: ['approvals:1'], reviews: [...reviews, r('bob', 'CHANGES_REQUESTED', 'head', '6')], author: 'me', headSha: 'head' }).pass, false);
  assert.equal(quorum({ labels: ['approvals:0'], reviews: [], author: 'me', headSha: 'head' }).pass, true);
  assert.equal(quorum({ labels: [], reviews: [], author: 'me', headSha: 'head' }).pass, true);
});

test('publish: a PR that needs people gets approvals:N, needs-human, reviewers and one notice (edited in place)', () => {
  const root = fixRepo({ merges: [{ key: 'BUG-3', files: { 'src/Basket.API/A.cs': 'a' } }, { key: 'BUG-7', files: { 'src/Identity.API/B.cs': 'b' } }] });
  write(root, '.github/CODEOWNERS', '* @armando @landon\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'codeowners');
  cacheTicket(root, 'BUG-3', { number: 3 });
  cacheTicket(root, 'BUG-7', { number: 7 });
  cleanMetrics(root, ['BUG-3', 'BUG-7']);
  const gh = fakeGh();
  gh.addIssue(3, { assignees: ['dana'] });
  gh.addIssue(7);
  const pr = gh.addPr(5, { author: 'armando', labels: ['approvals:3'], checks: [{ name: 'ci', bucket: 'pass' }] });
  const config = gateConfigFor(root, { autoMerge: { enabled: true } });
  const agent = fakeTriage({ 'BUG-3': low, 'BUG-7': low });
  const r = publishGate(config, { pr: pr.url, keys: ['BUG-3', 'BUG-7'], base: 'main' }, { gh: gh.gh, runAgent: agent.runAgent });
  assert.equal(r.decision.action, 'review');
  assert.equal(r.assessment.tickets[1].severity.level, 'High');
  assert.deepEqual(pr.labels.sort(), ['approvals:1', 'needs-human']);
  assert.deepEqual(pr.reviewers, ['dana', 'landon']);
  assert.equal(pr.comments.length, 1);
  assert.match(pr.comments[0].body, /What triggered review:\*\* BUG-7 is High \(Identity\.API; .*floor High \(src\/Identity\.API\/\*\*\)/);
  assert.match(pr.comments[0].body, /BUG-3 would have auto-merged/);
  // A second run edits the same notice.
  publishGate(config, { pr: pr.url, keys: ['BUG-3', 'BUG-7'], base: 'main' }, { gh: gh.gh, runAgent: agent.runAgent });
  assert.equal(pr.comments.length, 1);
  assert.equal(parseState(pr.comments[0].body).required, true);
});

test('publish: a qualifying PR whose checks are still running waits, with no labels', () => {
  const root = fixRepo({ files: { 'src/Basket.API/A.cs': 'a' } });
  cacheTicket(root, 'BUG-3', { number: 3 });
  cleanMetrics(root, ['BUG-3']);
  const gh = fakeGh();
  gh.addIssue(3);
  const pr = gh.addPr(6, { checks: [{ name: 'ci', bucket: 'pending' }] });
  const r = publishGate(gateConfigFor(root, { autoMerge: { enabled: true } }), { pr: pr.url, keys: ['BUG-3'], base: 'main' }, { gh: gh.gh, runAgent: fakeTriage({ 'BUG-3': low }).runAgent });
  assert.equal(r.decision.action, 'wait');
  assert.deepEqual(pr.labels, []);
  assert.match(pr.comments[0].body, /waiting for the checks/);
  assert.equal(parseState(pr.comments[0].body).action, 'wait');
});
