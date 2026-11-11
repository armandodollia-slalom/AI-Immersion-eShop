// QE e2e runs on leased stack slots: when they lease, when they stay on slot 0, and the cleanup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { onLeasedSlot, slotAware, wantsSlot } from '../lib/slots.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-slots-'));
fs.mkdirSync(path.join(root, 'e2e/teststack'), { recursive: true });
fs.writeFileSync(path.join(root, 'e2e/teststack/good.spec.ts'), "import { CATALOG_URL } from './ports';\ntest('TC-X-1-01', () => fetch(`${CATALOG_URL}/api`));\n");
fs.writeFileSync(path.join(root, 'e2e/teststack/old.spec.ts'), "test('TC-X-1-02', () => fetch('http://localhost:18082/api'));\n");

const fakeStack = ({ lease = { ok: true, slot: 3, webappUrl: 'http://localhost:21080' }, upStatus = 0 } = {}) => {
  const calls = [];
  return {
    calls,
    deps: {
      lease: (owner) => (calls.push(['lease', owner]), lease),
      release: (slot) => calls.push(['release', slot]),
      teststack: async (r, slot, args) => (calls.push(['teststack', slot, ...args]), { status: args[0] === 'up' ? upStatus : 0 }),
    },
  };
};

const withEnv = async (vars, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
};

test('slotAware: specs with literal 18xxx ports stay on slot 0', () => {
  assert.equal(slotAware(["fetch(`${CATALOG_URL}/x`)"]), true);
  assert.equal(slotAware(["'http://localhost:18080/'"]), false);
  assert.equal(slotAware(["'http://host.docker.internal:18081/Account'"]), false);
});

test('wantsSlot: only when several tickets run at once and qe.useSlots is on', () => {
  assert.equal(wantsSlot({}, { IMPLEMENT_PARALLEL: '1' }), false);
  assert.equal(wantsSlot({}, { IMPLEMENT_PARALLEL: '4' }), true);
  assert.equal(wantsSlot({ useSlots: false }, { IMPLEMENT_PARALLEL: '4' }), false);
  assert.equal(wantsSlot({}, { QE_USE_SLOTS: '1' }), true);
});

test('onLeasedSlot: leases, brings the slot up, runs with TESTSTACK_SLOT/URL, then downs and releases it', async () => {
  const s = fakeStack();
  const out = await withEnv({ IMPLEMENT_PARALLEL: '3' }, () => onLeasedSlot({ root }, { key: 'X-1', specFiles: ['e2e/teststack/good.spec.ts'], timeoutSec: 60 }, async (env) => ['ran', env], s.deps));
  assert.deepEqual(out, ['ran', { TESTSTACK_SLOT: '3', TESTSTACK_URL: 'http://localhost:21080' }]);
  assert.deepEqual(s.calls, [['lease', 'qe-X-1'], ['teststack', 3, 'up'], ['teststack', 3, 'down'], ['release', 3]]);
});

test('onLeasedSlot: falls back to slot 0 (null) for slot-0 specs, no free slot, or a stack that does not come up', async () => {
  await withEnv({ IMPLEMENT_PARALLEL: '3' }, async () => {
    const run = async () => 'ran';
    const legacy = fakeStack();
    assert.equal(await onLeasedSlot({ root }, { key: 'X-1', specFiles: ['e2e/teststack/good.spec.ts', 'e2e/teststack/old.spec.ts'] }, run, legacy.deps), null);
    assert.deepEqual(legacy.calls, [], 'no lease for slot-0 specs');
    const none = fakeStack({ lease: null });
    assert.equal(await onLeasedSlot({ root }, { key: 'X-1', specFiles: ['e2e/teststack/good.spec.ts'] }, run, none.deps), null);
    const broken = fakeStack({ upStatus: 1 });
    assert.equal(await onLeasedSlot({ root }, { key: 'X-1', specFiles: ['e2e/teststack/good.spec.ts'] }, run, broken.deps), null);
    assert.deepEqual(broken.calls.at(-1), ['release', 3], 'the lease is released even when up fails');
  });
  assert.equal(await onLeasedSlot({ root }, { key: 'X-1', specFiles: [] }, async () => 'ran', fakeStack().deps), null, 'one ticket at a time: slot 0');
});
