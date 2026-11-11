// Re-running a ticket a human resolved: plan() treats escalation-resolved as permission to run it again,
// the re-run clears the label and the old escalation notes, and the human decisions reach the implementer,
// pair and verifier prompts (scripts/pipeline/lib/human-decisions.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { decisionsBlock, readDecisions } from '../../pipeline/lib/human-decisions.mjs';
import { plan, startResolvedReruns } from '../lib/implement.mjs';
import { codeVerifierTask, integrationTask, pairImplementerTask, planTask, uiVerifierTask } from '../lib/tasks.mjs';

const DECISIONS = '## Decisions\n\n### Round 1 (resolved by @armando, 2026-11-11T10:21:00Z)\n\n- **Q1. What should the cart show?** A. Recalculate from the catalog price';

// Cached tickets: <dir>/<KEY>/story.md + meta.json with the issue's labels.
function tickets(defs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-rerun-'));
  for (const [key, { labels = ['story'], decisions = null }] of Object.entries(defs)) {
    fs.mkdirSync(path.join(dir, key), { recursive: true });
    fs.writeFileSync(path.join(dir, key, 'story.md'), `# ${key} Ticket\n`);
    fs.writeFileSync(path.join(dir, key, 'meta.json'), JSON.stringify({ key, type: 'bug', issue: { number: 1, labels } }));
    if (decisions) fs.writeFileSync(path.join(dir, key, 'decisions.md'), `${decisions}\n`);
  }
  return dir;
}

test('escalation-resolved is permission to re-run: no resume of the old run, as with --force for that ticket only', () => {
  const dir = tickets({ 'BUG-1': { labels: ['story', 'escalation-resolved'] }, 'BUG-2': {} });
  const config = { baseRef: 'origin/main', root: dir, stateDir: '.agent-state', implement: { branchPrefix: 'fix/', worktreeDir: '../{repo}-wt' } };
  const runs = path.join(dir, '.agent-state', 'implement');
  fs.mkdirSync(runs, { recursive: true });
  // Both died part-way with a worktree left: BUG-2 resumes it, BUG-1 (resolved) starts fresh.
  for (const key of ['BUG-1', 'BUG-2']) fs.writeFileSync(path.join(runs, `${key}.json`), JSON.stringify({ key, worktree: dir, status: 'finished', outcome: 'error' }));
  const by = Object.fromEntries(plan(config, [path.join(dir, 'BUG-1'), path.join(dir, 'BUG-2')]).map((s) => [s.key, s]));
  assert.equal(by['BUG-1'].resolved, true);
  assert.equal(by['BUG-1'].skip, null);
  assert.equal(by['BUG-1'].resume, false, 'the earlier run record is ignored, like --force');
  assert.equal(by['BUG-2'].resolved, false);
  assert.equal(by['BUG-2'].resume, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a resolved re-run clears the label and the old escalation notes of that ticket only', () => {
  const dir = tickets({ 'BUG-1': {} });
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-rerun-wt-'));
  const notes = path.join(wt, '.agent-state', 'escalations');
  fs.mkdirSync(notes, { recursive: true });
  for (const f of ['BUG-1-qe.md', 'BUG-1-review.md', 'BUG-10-qe.md']) fs.writeFileSync(path.join(notes, f), 'note');
  const events = [];
  const started = startResolvedReruns({ root: dir, stateDir: '.agent-state' }, [{ key: 'BUG-1', resolved: true, skip: null, worktree: wt }, { key: 'BUG-2', resolved: true, skip: 'claimed by x' }, { key: 'BUG-3', resolved: false, skip: null }], { event: (_root, key, args) => events.push([key, ...args]) });
  assert.deepEqual(started, ['BUG-1']);
  assert.deepEqual(events, [['BUG-1', 'clear-resolved', 'BUG-1']]);
  assert.deepEqual(fs.readdirSync(notes), ['BUG-10-qe.md']);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(wt, { recursive: true, force: true });
});

test('the human decisions go into the implementer, pair and verifier prompts as binding requirements', () => {
  const dir = tickets({ 'BUG-1': { decisions: DECISIONS }, 'BUG-2': {} });
  const decisions = readDecisions(path.join(dir, 'BUG-1', 'story.md'));
  assert.equal(decisions, DECISIONS);
  assert.equal(readDecisions(path.join(dir, 'BUG-2', 'story.md')), null);
  assert.deepEqual(decisionsBlock(null), []);

  const st = { id: 'cart', goal: 'g', owns: ['src/WebApp/**'], acceptance: ['a'], verify: 'code' };
  const common = { key: 'BUG-1', storyFile: path.join(dir, 'BUG-1', 'story.md'), worktree: dir, branch: 'b', base: '0123456789abcdef' };
  const prompts = {
    plan: planTask({ ...common, uiStory: false, limits: { maxSubtasks: 4, selfModeMaxFiles: 5, maxLargeSubtasks: 1 }, decisions }),
    pair: pairImplementerTask({ ...common, st, round: 1, maxRounds: 3, decisions }),
    integrate: integrationTask({ ...common, plan: { subtasks: [st] }, notes: [], decisions }),
    verifier: codeVerifierTask({ key: 'BUG-1', st, round: 1, maxRounds: 3, diff: '', checks: '', diagnostics: '', decisions }),
    ui: uiVerifierTask({ key: 'BUG-1', st, round: 1, maxRounds: 3, diff: '', checks: '', diagnostics: '', webappUrl: 'http://x', screenshotsDir: '/tmp/s', worktree: dir, decisions }),
  };
  for (const [name, text] of Object.entries(prompts)) {
    assert.match(text, /### Human decisions \(binding requirements\)/, name);
    assert.match(text, /Q1\. What should the cart show\?\*\* A\. Recalculate from the catalog price/, name);
  }
  assert.match(prompts.pair, /Where a decision and the story differ, the decision wins/);
  assert.match(prompts.verifier, /code that contradicts a decision is a blocking finding/);
  assert.match(prompts.verifier, /Do not reopen a decision/);
  assert.match(decisionsBlock(decisions, 'qe').join('\n'), /Report implementation behavior that contradicts a decision as a product bug/);
  assert.doesNotMatch(pairImplementerTask({ ...common, st, round: 1, maxRounds: 3 }), /Human decisions/, 'no decisions, no block');
  fs.rmSync(dir, { recursive: true, force: true });
});
