import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { blockersOf, collectStories, orderStories, worktreeFor } from '../lib/batch.mjs';
import { implChanges } from '../../pipeline/lib/git.mjs';
import { approvedOnDisk, loadRun, plan, recordUnrun, skippedOutcome } from '../lib/implement.mjs';

function storiesDir(stories) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-unit-'));
  for (const [name, text] of Object.entries(stories)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const blocked = (...keys) => `* **Blocked by:** ${keys.map((k) => `[${k}](${k}-x.md)`).join(', ')} (partial: only the API)\n`;

test('blockersOf reads only the "Blocked by" line and ignores the story itself', () => {
  assert.deepEqual(blockersOf(`# PROMO-4 Coupons\n\nSee PROMO-9.\n${blocked('PROMO-1', 'PROMO-5', 'PROMO-4')}`, 'PROMO-4'), ['PROMO-1', 'PROMO-5']);
  assert.deepEqual(blockersOf('# X-1\n\n* **Blocked by:** none\n', 'X-1'), []);
});

test('stories run after their in-batch blockers, stack on the blocker that already contains the others, and skip implemented ones', () => {
  const dir = storiesDir({
    'A-1-base.md': '# A-1 Base\n\n## Implementation Notes\n\ndone\n',
    'A-2-api.md': `# A-2 Api\n${blocked('A-1')}`,
    'A-3-ui.md': `# A-3 Ui\n${blocked('A-2', 'A-1')}`,
    'A-10-checkout.md': `# A-10 Checkout\n${blocked('A-3', 'A-4', 'OUT-1')}`,
    'A-4-orders.md': '# A-4 Orders\n',
    'notes.md': 'not a story',
  });
  const config = { baseRef: 'origin/main', root: dir, stateDir: '.agent-state', implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  const stories = plan(config, [dir]);
  assert.deepEqual(stories.map((s) => s.key), ['A-1', 'A-2', 'A-3', 'A-4', 'A-10']);
  const by = Object.fromEntries(stories.map((s) => [s.key, s]));
  assert.match(by['A-1'].skip, /already implemented/);
  assert.equal(by['A-2'].base, 'origin/main', 'an already-implemented blocker is on the base branch');
  assert.deepEqual([by['A-3'].base, by['A-3'].merge], ['feat/a-2-api', []]);
  assert.deepEqual([by['A-10'].base, by['A-10'].merge], ['feat/a-3-ui', ['feat/a-4-orders']], 'out-of-batch blockers are left to the implementer');
  assert.equal(by['A-10'].worktree, path.resolve(dir, `../${path.basename(dir)}-wt/a-10`));
  assert.equal(plan(config, [dir], { force: true })[0].skip, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a later run resumes the stories an interrupted run left part-way, in their worktree', () => {
  const dir = storiesDir({ 'B-1-a.md': '# B-1 A\n', 'B-2-b.md': '# B-2 B\n', 'B-3-c.md': '# B-3 C\n' });
  const config = { baseRef: 'origin/main', root: dir, stateDir: '.agent-state', implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  const runs = path.join(dir, '.agent-state', 'implement');
  fs.mkdirSync(runs, { recursive: true });
  const record = (key, patch) => fs.writeFileSync(path.join(runs, `${key}.json`), JSON.stringify({ key, worktree: dir, ...patch }));
  record('B-1', { status: 'running' });
  record('B-2', { status: 'finished', outcome: 'qe-crashed' });
  record('B-3', { status: 'finished', outcome: 'review-failed' });
  const by = Object.fromEntries(plan(config, [dir]).map((s) => [s.key, s]));
  assert.deepEqual([by['B-1'].resume, by['B-2'].resume, by['B-3'].resume], [true, true, false]);
  assert.equal(plan(config, [dir], { force: true })[0].resume, false, '--force starts over');
  // A record that never got its worktree resumes in the story's own worktree path.
  const wt = worktreeFor(config, { key: 'B-1' });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(runs, 'B-1.json'), JSON.stringify({ key: 'B-1', status: 'finished', outcome: 'error' }));
  assert.equal(plan(config, [dir])[0].resume, true);
  fs.rmSync(wt, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a story whose escalation still stands keeps its outcome and its dependents stay blocked; handling it or --force runs it again', () => {
  const dir = storiesDir({ 'B-1-a.md': '# B-1 A\n', 'B-2-b.md': `# B-2 B\n\n${blocked('B-1')}`, 'B-3-c.md': '# B-3 C\n' });
  const config = { baseRef: 'origin/main', root: dir, stateDir: '.agent-state', implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  const runs = path.join(dir, '.agent-state', 'implement');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'B-1.json'), JSON.stringify({ key: 'B-1', worktree: dir, status: 'finished', outcome: 'qe-escalated' }));
  fs.writeFileSync(path.join(runs, 'B-3.json'), JSON.stringify({ key: 'B-3', worktree: dir, status: 'finished', outcome: 'review-escalated' }));
  const escalations = path.join(dir, '.agent-state', 'escalations');
  fs.mkdirSync(escalations, { recursive: true });
  fs.writeFileSync(path.join(escalations, 'B-1-automation.md'), '# B-1 automation: tests did not reach 9/10\n');
  fs.writeFileSync(path.join(escalations, 'B-3-review.md'), '# B-3 review: did not converge\n');
  const by = Object.fromEntries(plan(config, [dir]).map((s) => [s.key, s]));
  assert.match(by['B-1'].skip, /qe-escalated in a previous run: its escalation waits for a human/);
  assert.deepEqual(skippedOutcome(by['B-1']).outcome, 'qe-escalated');
  assert.equal(by['B-3'].escalatedBefore, 'review-escalated');
  assert.deepEqual(by['B-2'].deps, ['B-1'], 'the escalated blocker still blocks B-2');
  const forced = Object.fromEntries(plan(config, [dir], { force: true }).map((s) => [s.key, s]));
  assert.equal(forced['B-1'].skip, null);
  // Once the escalation is handled (its note cleared), the story runs again without --force.
  fs.rmSync(path.join(escalations, 'B-1-automation.md'));
  assert.equal(plan(config, [dir]).find((s) => s.key === 'B-1').skip, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dependency cycles and duplicate keys are errors', () => {
  const dir = storiesDir({ 'C-1-a.md': `# C-1\n${blocked('C-2')}`, 'C-2-b.md': `# C-2\n${blocked('C-1')}` });
  assert.throws(() => orderStories(collectStories([dir])), /cycle between stories: C-1 -> C-2 -> C-1/);
  fs.writeFileSync(path.join(dir, 'C-1-dupe.md'), '# C-1\n');
  assert.throws(() => collectStories([dir]), /Two story files for C-1/);
  assert.throws(() => collectStories([path.join(dir, 'missing.md')]), /No such file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('approvedOnDisk: a resumed story stacked on a group branch matches the hash its review approved against that branch', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-approved-'));
  const g = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  write('src/A.cs', '// a\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  // The group branch already carries an earlier ticket; the story stacks on it.
  g('switch', '-q', '-c', 'bugfix/group');
  write('src/Earlier.cs', '// earlier ticket\n');
  g('add', '-A');
  g('commit', '-qm', 'earlier');
  g('switch', '-q', '-c', 'feat/story');
  write('src/Story.cs', '// this story\n');
  write('tests/StoryTests.cs', '// QE work in progress is not implementation\n');
  const wt = { root: repo, baseRef: 'main', implExclude: ['tests'] };
  const approvedHash = implChanges({ ...wt, baseRef: 'bugfix/group' }).hash;
  const prior = { done: { hash: approvedHash }, review: { lastVerdict: 'APPROVED', approvedHash } };
  assert.equal(approvedOnDisk(wt, prior, 'bugfix/group'), true);
  assert.notEqual(implChanges(wt).hash, approvedHash, 'against main the earlier ticket is in the diff');
  write('src/Story.cs', '// changed after the review\n');
  assert.equal(approvedOnDisk(wt, prior, 'bugfix/group'), false);
  assert.equal(approvedOnDisk(wt, { ...prior, review: { ...prior.review, lastVerdict: 'CHANGES_REQUESTED' } }, 'bugfix/group'), false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a cached ticket whose issue is closed counts as implemented, even without Implementation Notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-ticket-'));
  const ticket = (key, state) => {
    fs.mkdirSync(path.join(dir, key));
    fs.writeFileSync(path.join(dir, key, 'story.md'), `# ${key}: Story\n\n**Blocked by:** None\n`);
    fs.writeFileSync(path.join(dir, key, 'meta.json'), JSON.stringify({ key, slug: key.toLowerCase(), issue: { number: 1, state } }));
  };
  ticket('DEMO-1', 'CLOSED');
  ticket('DEMO-2', 'OPEN');
  const byKey = Object.fromEntries(collectStories([path.join(dir, 'DEMO-1'), path.join(dir, 'DEMO-2')]).map((s) => [s.key, s.implemented]));
  assert.deepEqual(byKey, { 'DEMO-1': true, 'DEMO-2': false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a ticket labeled escalation-resolved runs again despite its standing qe escalation, like --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-resolved-'));
  const ticket = (key, labels) => {
    fs.mkdirSync(path.join(dir, key));
    fs.writeFileSync(path.join(dir, key, 'story.md'), `# ${key}: Story\n\n**Blocked by:** None\n`);
    fs.writeFileSync(path.join(dir, key, 'meta.json'), JSON.stringify({ key, slug: key.toLowerCase(), issue: { number: 1, state: 'OPEN', labels } }));
  };
  ticket('B-1', ['bug', 'escalation-resolved']);
  ticket('B-2', ['bug']);
  const config = { baseRef: 'origin/main', root: dir, stateDir: '.agent-state', implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  const runs = path.join(dir, '.agent-state', 'implement');
  fs.mkdirSync(runs, { recursive: true });
  const escalations = path.join(dir, '.agent-state', 'escalations');
  fs.mkdirSync(escalations, { recursive: true });
  for (const key of ['B-1', 'B-2']) {
    fs.writeFileSync(path.join(runs, `${key}.json`), JSON.stringify({ key, worktree: dir, status: 'finished', outcome: 'qe-escalated' }));
    fs.writeFileSync(path.join(escalations, `${key}-automation.md`), `# ${key} automation: tests did not reach 9/10\n`);
  }
  const by = Object.fromEntries(plan(config, [path.join(dir, 'B-1'), path.join(dir, 'B-2')]).map((s) => [s.key, s]));
  assert.equal(by['B-1'].resolved, true);
  assert.equal(by['B-1'].skip, null, 'the resolved label bypasses the standing escalation');
  assert.equal(by['B-1'].resume, false, 'it starts fresh, as with --force');
  assert.match(by['B-2'].skip, /qe-escalated in a previous run: its escalation waits for a human/, 'without the label it still waits');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordUnrun: a ticket the batch never ran gets its outcome recorded once, so its failure is not posted again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-unrun-'));
  const config = { root: dir, stateDir: '.agent-state' };
  fs.mkdirSync(path.join(dir, '.agent-state', 'implement'), { recursive: true });
  const skipped = { key: 'B-2', outcome: 'skipped', reason: 'blocker B-1 ended qe-escalated' };
  recordUnrun(config, skipped);
  const first = loadRun(config, 'B-2');
  assert.deepEqual([first.outcome, first.reason, first.status], ['skipped', 'blocker B-1 ended qe-escalated', 'finished']);
  recordUnrun(config, skipped);
  assert.equal(loadRun(config, 'B-2').finishedAt, first.finishedAt, 'the same outcome keeps its finish time (a replay, not a new failure)');
  // A story that ran keeps its own record (a done worker whose merge failed stays merge-only).
  fs.writeFileSync(path.join(dir, '.agent-state', 'implement', 'B-3.json'), JSON.stringify({ key: 'B-3', outcome: 'done', status: 'finished' }));
  recordUnrun(config, { key: 'B-3', outcome: 'merge-conflict', reason: 'x' });
  assert.equal(loadRun(config, 'B-3').outcome, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});
