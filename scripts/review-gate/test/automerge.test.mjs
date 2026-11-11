// Review gate, step 4: auto-merge for Low PRs, behind implement.autoMerge.enabled, through one merge
// function with a configurable identity.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseState } from '../lib/gate.mjs';
import { mergeIdentity, mergePr } from '../lib/github.mjs';
import { publishGate } from '../lib/publish.mjs';
import { syncGate } from '../lib/sync.mjs';
import { fakeGh } from './fake-gh.mjs';
import { cacheTicket, cleanMetrics, fakeTriage, fixRepo, gateConfigFor, git, low } from './helpers.mjs';

function lowPr({ checks = 'pass', autoMerge = { enabled: true } } = {}) {
  const root = fixRepo({ files: { 'src/Basket.API/A.cs': 'a' } });
  cacheTicket(root, 'BUG-3', { number: 3 });
  cleanMetrics(root, ['BUG-3']);
  const gh = fakeGh();
  gh.addIssue(3);
  const pr = gh.addPr(8, { labels: [], checks: [{ name: 'ci', bucket: checks }], headRefOid: git(root, 'rev-parse', 'HEAD') });
  const config = gateConfigFor(root, { autoMerge });
  const publish = () => publishGate(config, { pr: pr.url, keys: ['BUG-3'], base: 'main' }, { gh: gh.gh, runAgent: fakeTriage({ 'BUG-3': low }).runAgent });
  return { root, gh, pr, config, publish };
}

test('merge identity: gh-user uses the gh login; app needs its installation token; anything else is refused', () => {
  assert.deepEqual(mergeIdentity({ identity: 'gh-user' }), { identity: 'gh-user', env: undefined });
  assert.equal(mergeIdentity({ identity: 'app', appTokenEnv: 'X_TOKEN' }, { X_TOKEN: 't0k' }).env.GH_TOKEN, 't0k');
  assert.throws(() => mergeIdentity({ identity: 'app' }, {}), /REVIEW_GATE_APP_TOKEN is not set/);
  assert.throws(() => mergeIdentity({ identity: 'bot' }), /must be "gh-user" or "app"/);
  const gh = fakeGh();
  gh.addPr(1);
  mergePr(gh.gh, 'acme/shop', 1, { identity: 'app', appTokenEnv: 'PATH' });
  assert.deepEqual(gh.merges[0].args.slice(0, 5), ['pr', 'merge', '1', '-R', 'acme/shop']);
  assert.ok(gh.merges[0].args.includes('--auto') && gh.merges[0].args.includes('--squash'));
  assert.equal(gh.merges[0].token, process.env.PATH, 'the app token becomes GH_TOKEN');
});

test('a Low, high-confidence PR with green checks auto-merges and is labeled auto-merged', () => {
  const w = lowPr();
  const r = w.publish();
  assert.equal(r.decision.action, 'auto-merge');
  assert.equal(w.gh.merges.length, 1);
  assert.ok(w.pr.autoMerge);
  assert.deepEqual(w.pr.labels.sort(), ['approvals:0', 'auto-merged']);
  assert.deepEqual(w.pr.reviewers, []);
  assert.match(w.pr.comments[0].body, /## Review gate: auto-merge/);
  assert.equal(parseState(w.pr.comments[0].body).merge.identity, 'gh-user');
});

test('the kill switch: with implement.autoMerge.enabled false the same PR needs one approval', () => {
  const w = lowPr({ autoMerge: { enabled: false } });
  const r = w.publish();
  assert.equal(r.decision.action, 'review');
  assert.equal(w.gh.merges.length, 0);
  assert.deepEqual(w.pr.labels.sort(), ['approvals:1', 'needs-human']);
  assert.match(w.pr.comments[0].body, /auto-merge is switched off/);
});

test('a merge GitHub refuses sends the PR to review with the reason', () => {
  const w = lowPr();
  w.gh.refuseMerge = 'auto-merge is not allowed for this repository';
  const r = w.publish();
  assert.equal(r.decision.action, 'review');
  assert.deepEqual(w.pr.labels.sort(), ['approvals:1', 'needs-human']);
  assert.match(w.pr.comments[0].body, /auto-merge failed \(gh pr merge .* failed: auto-merge is not allowed for this repository\)/);
});

test('board sync merges a waiting PR once its checks pass; failing checks send it to review', () => {
  const w = lowPr({ checks: 'pending' });
  assert.equal(w.publish().decision.action, 'wait');
  const deps = { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null };
  assert.deepEqual(syncGate(w.config, deps).regated, [w.pr.url]);
  assert.equal(w.gh.merges.length, 0, 'still pending');
  w.pr.checks = [{ name: 'ci', bucket: 'pass' }];
  syncGate(w.config, deps);
  assert.equal(w.gh.merges.length, 1);
  assert.ok(w.pr.labels.includes('auto-merged'));

  const f = lowPr({ checks: 'pending' });
  f.publish();
  f.pr.checks = [{ name: 'ci', bucket: 'fail' }];
  syncGate(f.config, { gh: f.gh.gh, items: [], metricsConfig: f.config, markerOf: () => null });
  assert.equal(f.gh.merges.length, 0);
  assert.deepEqual(f.pr.labels.sort(), ['approvals:1', 'needs-human']);
  assert.match(f.pr.comments[0].body, /checks are failing/);
});

test('a push to a waiting PR before its checks pass sends it to review instead of merging', () => {
  const w = lowPr({ checks: 'pending' });
  w.publish();
  w.pr.headRefOid = 'pushed-by-someone';
  w.pr.checks = [{ name: 'ci', bucket: 'pass' }];
  syncGate(w.config, { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null });
  assert.equal(w.gh.merges.length, 0);
  assert.match(w.pr.comments[0].body, /changed after it was assessed/);
});
