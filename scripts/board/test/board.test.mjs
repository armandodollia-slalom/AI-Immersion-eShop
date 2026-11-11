// Unit tests for the board stage's pure logic (no GitHub calls).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnForState, isForward, pickable, storyKind } from '../lib/board.mjs';
import { parseNetwork, redact, renderEvidence, tracesFromReport } from '../lib/evidence.mjs';

const config = { board: { repo: 'acme/shop', storyLabel: 'story', blockedLabel: 'needs-human' } };

test('story kind comes from the [FE]/[BE] tag in the title', () => {
  assert.equal(storyKind('# PROMO-6: [FE - WebApp, WebAppComponents] - Display\n'), 'ui');
  assert.equal(storyKind('# BUG-6: [BE - Basket.API, Identity.API] - Scope\n'), 'api');
  assert.equal(storyKind('# X-1: Something\n[FE - later]'), 'other');
});

test('cards only move forward unless forced', () => {
  assert.ok(isForward(null, 'inProgress'));
  assert.ok(isForward('backlog', 'ready'));
  assert.ok(!isForward('ready', 'backlog'));
  assert.ok(isForward('inProgress', 'testing'));
  assert.ok(!isForward('review', 'testing'));
  assert.ok(!isForward('testing', 'testing'));
});

test('the stop hook never sets Testing; it asks for Pending Review once verified (interactive only)', () => {
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
