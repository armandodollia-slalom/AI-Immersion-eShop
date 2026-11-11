// Unit tests for the board stage's pure logic (no GitHub calls).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLUMNS, columnForState, failureComment, isForward, pickable, storyKind } from '../lib/board.mjs';
import { parseNetwork, redact, renderEvidence, tracesFromReport } from '../lib/evidence.mjs';

const config = { board: { repo: 'acme/shop', storyLabel: 'story', blockedLabel: 'needs-human', columns: { ready: 'Ready', failed: 'Failed' } } };

test('story kind comes from the [FE]/[BE] tag in the title', () => {
  assert.equal(storyKind('# PROMO-6: [FE - WebApp, WebAppComponents] - Display\n'), 'ui');
  assert.equal(storyKind('# BUG-6: [BE - Basket.API, Identity.API] - Scope\n'), 'api');
  assert.equal(storyKind('# X-1: Something\n[FE - later]'), 'other');
});

test('cards only move forward unless forced', () => {
  assert.ok(isForward(null, 'inProgress'));
  assert.ok(isForward('backlog', 'ready'));
  assert.ok(!isForward('ready', 'backlog'));
  assert.ok(isForward('inProgress', 'review'));
  assert.ok(!isForward('review', 'inProgress'));
  assert.ok(!isForward('review', 'review'));
});

test('the Failed lane sits between Pending Review and Done, so no hook moves a card out of it', () => {
  assert.deepEqual(COLUMNS, ['backlog', 'ready', 'inProgress', 'review', 'failed', 'done']);
  assert.ok(isForward('inProgress', 'failed'));
  assert.ok(!isForward('failed', 'inProgress'), 'pipeline start does not drag a failed card back');
  assert.ok(!isForward('failed', 'review'));
  assert.ok(!isForward('failed', 'ready'), 'only a forced move (a human) retries it');
});

test('the failure comment carries the outcome, reason, findings, branch and log', () => {
  const body = failureComment(
    config,
    {
      outcome: 'pair-exhausted',
      reason: 'subtask api was not approved after 3 rounds',
      branch: 'feat/demo-1-x',
      log: '.agent-state/logs/implement-DEMO-1.log',
      findings: [{ subtask: 'api', file: 'src/A.cs', line: 12, issue: 'no owner check', fix: 'check buyer id' }, { subtask: 'ui', file: 'src/WebApp/X.razor', issue: 'button hidden', screenshot: '/tmp/s/round-3/cart.png' }, 'plain text finding'],
    },
    { host: 'box' },
  );
  assert.match(body, /\*\*pair-exhausted\*\* \(subtask api was not approved after 3 rounds\)/);
  assert.match(body, /- \[api\] `src\/A\.cs:12` no owner check Fix: check buyer id/);
  assert.match(body, /screenshot: `\/tmp\/s\/round-3\/cart\.png`/);
  assert.match(body, /- plain text finding/);
  assert.match(body, /Branch: `feat\/demo-1-x`\. Log on `box`: `\.agent-state\/logs\/implement-DEMO-1\.log`/);
  assert.match(body, /remove the `needs-human` label and move the card back to Ready/);
});

test('the stop hook asks for Pending Review once verified (interactive only)', () => {
  assert.equal(columnForState({ automation: { status: 'idle' } }), null);
  assert.equal(columnForState({ automation: { status: 'running' } }), null);
  assert.equal(columnForState({ automation: { status: 'idle', requestedHash: 'h' } }), null);
  assert.equal(columnForState({ done: { hash: 'h' }, automation: { status: 'verified', requestedHash: null } }), 'review');
  assert.equal(columnForState({ done: { hash: 'h' }, automation: { status: 'verified', requestedHash: null } }, { headless: true }), null);
  assert.equal(columnForState({ done: null, automation: { status: 'verified' } }), null);
});

test('the picker takes open story cards in Ready (never Backlog) assigned to the user and skips parked ones', () => {
  const item = (over) => ({ key: 'BUG-1', column: 'ready', state: 'OPEN', repo: 'acme/shop', assignees: ['Me'], labels: ['story'], ...over });
  const items = [
    item({ number: 1 }),
    item({ number: 2, column: 'inProgress' }),
    item({ number: 9, column: 'backlog' }),
    item({ number: 10, column: 'failed' }),
    item({ number: 3, assignees: ['someone'] }),
    item({ number: 4, labels: ['story', 'needs-human'] }),
    item({ number: 5, state: 'CLOSED' }),
    item({ number: 6, repo: 'acme/other' }),
    item({ number: 7, key: null }),
    item({ number: 8, labels: [] }),
  ];
  assert.deepEqual(pickable(config, items, 'me').map((i) => i.number), [1]);
});

test('secrets in JSON and form bodies are redacted', () => {
  assert.deepEqual(JSON.parse(redact('{"access_token":"abc","user":{"password":"p","name":"n"}}')), { access_token: '***', user: { password: '***', name: 'n' } });
  assert.equal(redact('grant_type=password&password=p&client_secret=s&scope=basket', 'application/x-www-form-urlencoded'), 'grant_type=password&password=***&client_secret=***&scope=basket');
});

test('only API requests are read from a trace, with their bodies', () => {
  const resources = { 'req.json': '{"a":1}', 'res.json': '{"ok":true}' };
  const lines = [
    { type: 'resource-snapshot', snapshot: { _apiRequest: true, request: { method: 'POST', url: 'http://h/api/x?v=1', postData: { mimeType: 'application/json', _sha1: 'req.json' } }, response: { status: 201, statusText: 'Created', content: { mimeType: 'application/json', _sha1: 'res.json' } } } },
    { type: 'resource-snapshot', snapshot: { request: { method: 'GET', url: 'http://h/page' }, response: { status: 200, content: {} } } },
    { type: 'other' },
  ].map((l) => JSON.stringify(l));
  const [x, ...rest] = parseNetwork(`${lines.join('\n')}\nnot json`, (sha1) => resources[sha1]);
  assert.equal(rest.length, 0);
  assert.deepEqual({ method: x.method, status: x.status, req: JSON.parse(x.requestBody), res: JSON.parse(x.responseBody) }, { method: 'POST', status: 201, req: { a: 1 }, res: { ok: true } });
});

test('traces come from the last attempt of each test in the JSON report', () => {
  const report = { suites: [{ title: 'a.spec.ts', specs: [], suites: [{ title: 'group', specs: [{ title: 'TC-X-1-01 works', tests: [{ projectName: 'scenarios', results: [{ status: 'failed', attachments: [{ name: 'trace', path: 'first.zip' }] }, { status: 'passed', attachments: [{ name: 'trace', path: 'retry.zip' }] }] }] }] }] }] };
  assert.deepEqual(tracesFromReport(report), [{ title: 'TC-X-1-01 works', status: 'passed', trace: 'retry.zip' }]);
});

test('evidence Markdown is capped and says what it left out', () => {
  const exchange = { method: 'GET', url: 'http://h/api/items?page=1', status: 200, statusText: 'OK', requestBody: '', responseBody: 'x'.repeat(50), responseMime: 'application/json' };
  const tests = [{ title: 'TC-X-1-01 lists', status: 'passed', exchanges: [exchange, exchange, exchange] }];
  const md = renderEvidence('X-1', tests, { maxExchanges: 2, maxBodyChars: 10 });
  assert.match(md, /3 request\(s\) recorded from 1 verified test/);
  assert.match(md, /\*\*GET\*\* `\/api\/items\?page=1` → \*\*200 OK\*\*/);
  assert.match(md, /40 more characters/);
  assert.match(md, /1 more request\(s\) not shown/);
  assert.equal(md.match(/\*\*GET\*\*/g).length, 2);
});
