// The story guard and mockups: an agent may open the handed tickets' own mockups (and an epic run's epic
// mockups) in any checkout's ticket cache, and nothing else in any cache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { allowedSources, storyGuard, ticketOf } from '../lib/story-guard.mjs';
import { CACHE, seedTicket } from './fixtures/tickets.mjs';

const checkout = (root) => {
  for (const [key, over] of [
    ['epic-coupons', { type: 'epic', text: '# Epic: Coupons\n', mockups: { 'epic-coupons-journey/Journey.dc.html': '<x-dc></x-dc>' } }],
    ['epic-gifts', { type: 'epic', text: '# Epic: Gifts\n', mockups: { 'epic-gifts-journey/Journey.dc.html': '<x-dc></x-dc>' } }],
    ['DEMO-1', { text: '# DEMO-1 Coupon\n', parent: 'epic-coupons', mockups: { 'DEMO-1-coupon/README.md': '# r', 'DEMO-1-coupon/Main.dc.html': '<x-dc></x-dc>', 'DEMO-1-coupon/Main.png': 'png' } }],
    ['DEMO-2', { text: '# DEMO-2 Wrap\n', parent: 'epic-gifts', mockups: { 'DEMO-2-wrap/Main.png': 'png' } }],
  ])
    seedTicket(root, { key, ...over });
  return { root, stateDir: '.agent-state', tickets: { dir: CACHE }, storyGuard: { folders: [CACHE, 'legacy-stories'] }, abs: (p) => path.join(root, p) };
};

const main = checkout(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-main-'))));
const worktree = checkout(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-wt-'))));
const verdict = (config, tool_name, tool_input, env = {}) => (storyGuard(config, { tool_name, tool_input, cwd: config.root }, env) ? 'deny' : 'allow');
const own = `${CACHE}/DEMO-1/mockups/DEMO-1-coupon/Main.dc.html`;
const other = `${CACHE}/DEMO-2/mockups/DEMO-2-wrap/Main.png`;
const epic = `${CACHE}/epic-coupons/mockups/epic-coupons-journey/Journey.dc.html`;
const otherEpic = `${CACHE}/epic-gifts/mockups/epic-gifts-journey/Journey.dc.html`;

test('ticketOf finds the ticket in any checkout\'s cache', () => {
  assert.equal(ticketOf(path.join('/x/repo', own), CACHE), 'DEMO-1');
  assert.equal(ticketOf(path.join('/x/repo-worktrees/demo-1', CACHE), CACHE), '');
  assert.equal(ticketOf('/x/repo/src/WebApp/Main.razor', CACHE), null);
});

test('nothing handed: no mockups at all', () => {
  for (const p of [own, other, epic]) assert.equal(verdict(main, 'Read', { file_path: p }), 'deny', p);
});

test('a handed story opens its own mockups only', () => {
  const env = { PIPELINE_STORY_SOURCES: 'DEMO-1' };
  assert.equal(verdict(main, 'Read', { file_path: own }, env), 'allow');
  assert.equal(verdict(main, 'Read', { file_path: `${CACHE}/DEMO-1/mockups/DEMO-1-coupon/README.md` }, env), 'allow');
  assert.equal(verdict(main, 'Glob', { pattern: `${CACHE}/DEMO-1/mockups/**/*.dc.html` }, env), 'allow');
  assert.equal(verdict(main, 'Bash', { command: `cat ${own} && ls ${CACHE}/DEMO-1/mockups` }, env), 'allow');
  assert.equal(verdict(main, 'Read', { file_path: other }, env), 'deny', "another story's mockups");
  assert.equal(verdict(main, 'Read', { file_path: epic }, env), 'deny', "the epic's mockups were not handed");
  assert.equal(verdict(main, 'Glob', { pattern: `${CACHE}/*/mockups/**` }, env), 'deny', 'every ticket\'s mockups');
  assert.equal(verdict(main, 'Bash', { command: `cat ${own} ${other}` }, env), 'deny');
  assert.equal(verdict(main, 'Grep', { pattern: 'x', path: `${CACHE}/DEMO-2/mockups` }, env), 'deny');
});

test('an epic run opens the epic\'s mockups too, and no other epic\'s', () => {
  const env = { PIPELINE_STORY_SOURCES: ['DEMO-1', main.abs(`${CACHE}/epic-coupons`)].join(path.delimiter) };
  assert.equal(verdict(main, 'Read', { file_path: epic }, env), 'allow');
  assert.equal(verdict(main, 'Read', { file_path: own }, env), 'allow');
  assert.equal(verdict(main, 'Read', { file_path: otherEpic }, env), 'deny');
  assert.equal(verdict(main, 'Read', { file_path: other }, env), 'deny');
});

test('a ticket handed as the main checkout\'s folder opens its copy in a worktree; other checkouts\' caches stay closed', () => {
  const env = { PIPELINE_STORY_SOURCES: main.abs(`${CACHE}/DEMO-1`) };
  assert.equal(verdict(worktree, 'Read', { file_path: own }, env), 'allow', "the worktree's copy of the handed story's mockups");
  assert.equal(verdict(worktree, 'Read', { file_path: main.abs(own) }, env), 'allow', 'the main checkout copy');
  assert.equal(verdict(worktree, 'Read', { file_path: other }, env), 'deny');
  assert.equal(verdict(worktree, 'Read', { file_path: main.abs(other) }, env), 'deny', "another checkout's cache is guarded too");
  assert.equal(verdict(worktree, 'Bash', { command: `cat ${main.abs(other)}` }, env), 'deny');
  assert.ok(allowedSources(worktree, env).includes(worktree.abs(`${CACHE}/DEMO-1`)));
});

test('a symlink in a handed ticket cannot reach another ticket\'s mockups', () => {
  const link = main.abs(`${CACHE}/DEMO-1/mockups/DEMO-1-coupon/stolen.png`);
  fs.symlinkSync(main.abs(other), link);
  try {
    assert.equal(verdict(main, 'Read', { file_path: link }, { PIPELINE_STORY_SOURCES: 'DEMO-1' }), 'deny');
  } finally {
    fs.rmSync(link);
  }
});

test('handed folders outside the cache (the legacy story folder) still work as folders', () => {
  fs.mkdirSync(main.abs('legacy-stories/PROMO-1-x'), { recursive: true });
  const env = { PIPELINE_STORY_SOURCES: main.abs('legacy-stories/PROMO-1-x') };
  assert.equal(verdict(main, 'Read', { file_path: 'legacy-stories/PROMO-1-x/story.md' }, env), 'allow');
  assert.equal(verdict(main, 'Read', { file_path: 'legacy-stories/PROMO-2-y/story.md' }, env), 'deny');
});
