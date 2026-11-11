import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { blockersOf, collectStories, orderStories, worktreeFor } from '../lib/batch.mjs';
import { plan, skippedOutcome } from '../lib/implement.mjs';

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

test('a story still escalated from a previous run keeps its outcome and its dependents stay blocked; --force retries it', () => {
  const dir = storiesDir({ 'B-1-a.md': '# B-1 A\n', 'B-2-b.md': `# B-2 B\n\n${blocked('B-1')}`, 'B-3-c.md': '# B-3 C\n' });
  const config = { baseRef: 'origin/main', root: dir, stateDir: '.agent-state', implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  const runs = path.join(dir, '.agent-state', 'implement');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'B-1.json'), JSON.stringify({ key: 'B-1', worktree: dir, status: 'finished', outcome: 'qe-escalated' }));
  fs.writeFileSync(path.join(runs, 'B-3.json'), JSON.stringify({ key: 'B-3', worktree: dir, status: 'finished', outcome: 'review-escalated' }));
  const by = Object.fromEntries(plan(config, [dir]).map((s) => [s.key, s]));
  assert.match(by['B-1'].skip, /qe-escalated in a previous run: waits for a human/);
  assert.deepEqual(skippedOutcome(by['B-1']).outcome, 'qe-escalated');
  assert.equal(by['B-3'].escalatedBefore, 'review-escalated');
  assert.deepEqual(by['B-2'].deps, ['B-1'], 'the escalated blocker still blocks B-2');
  const forced = Object.fromEntries(plan(config, [dir], { force: true }).map((s) => [s.key, s]));
  assert.equal(forced['B-1'].skip, null);
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
