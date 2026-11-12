// Agent provider outages (quota and usage limits) are told apart from failed tasks and shared with the
// whole run through one marker file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { clearOutage, providerOutage, readOutage, recordOutage } from '../lib/outage.mjs';

test('providerOutage: Copilot quota and Claude usage limits are outages; work that quotes them is not', () => {
  assert.match(providerOutage({ stderr: 'Error: You have exceeded your monthly quota (Request ID: AEEA:2840B0)', status: 1 }), /monthly quota/);
  assert.match(providerOutage({ output: 'Claude AI usage limit reached|1731430800', status: 1 }), /usage limit reached/);
  assert.match(providerOutage({ output: "You've hit your limit · resets 3pm (America/Chicago)", status: 1 }), /hit your limit/);
  assert.match(providerOutage({ output: '5-hour limit reached ∙ resets 2pm', status: 0 }), /limit reached/);
  assert.equal(providerOutage({ output: 'Done.\nAGENT_RESULT: {"status":"ok"}', status: 0 }), null);
  assert.equal(providerOutage({ stderr: 'error: build failed', status: 1 }), null);
  // A long, successful answer about rate limits is the agent's work, not an outage.
  assert.equal(providerOutage({ output: `${'x'.repeat(1200)}\nthe API returns "usage limit reached" on 429`, status: 0 }), null);
});

test('the marker: recorded once, read by any process of the run after a given time, cleared by a new run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outage-'));
  const prev = process.env.PIPELINE_OUTAGE_FILE;
  try {
    delete process.env.PIPELINE_OUTAGE_FILE;
    recordOutage({ cli: 'copilot', agent: 'implementer', reason: 'quota' });
    assert.equal(readOutage(), null, 'no marker file: nothing recorded');
    process.env.PIPELINE_OUTAGE_FILE = path.join(dir, 'implement', 'agent-outage.json');
    const before = Date.now() - 1000;
    recordOutage({ cli: 'copilot', agent: 'implementer', reason: 'quota' });
    assert.equal(readOutage(before).agent, 'implementer');
    assert.equal(readOutage(Date.now() + 60_000), null, 'an outage before the run started does not count');
    clearOutage();
    assert.equal(readOutage(), null);
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_OUTAGE_FILE;
    else process.env.PIPELINE_OUTAGE_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
