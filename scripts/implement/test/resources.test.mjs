// Resource auto-sizing: the formula, macOS reclaimable pages, explicit overrides and back-pressure.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyResources, autoSize, memoryInfo, parallelFor, reclaimableBytes, waitForMemory } from '../lib/resources.mjs';

test('autoSize: about 6-8 tickets on a 48 GB / 14 CPU machine with ~30 GB free and a 15.6 GB Docker VM', () => {
  const r = autoSize({ totalGb: 48, freeGb: 30, dockerGb: 15.6 }, { cpus: 14 });
  assert.ok(r.parallel >= 6 && r.parallel <= 8, `parallel ${r.parallel}`);
  assert.equal(r.teststackSlots, 6, 'Docker holds 8 stacks besides slot 0, capped at parallel');
  assert.ok(r.maxConcurrentAgents >= r.parallel && r.maxConcurrentAgents <= 14);
  assert.ok(r.lspMaxServers >= r.parallel);
  assert.equal(autoSize({ totalGb: 48, freeGb: 34, dockerGb: 15.6 }, { cpus: 14 }).parallel, 8);
  assert.equal(r.reasons.length, 6);
});

test('autoSize: small machines get one ticket and one pair; CPUs and maxParallel cap it; no Docker leaves slots alone', () => {
  const small = autoSize({ totalGb: 8, freeGb: 4, dockerGb: null }, { cpus: 4 });
  assert.deepEqual([small.parallel, small.maxConcurrentPairs, small.teststackSlots], [1, 1, null]);
  assert.equal(autoSize({ totalGb: 128, freeGb: 100, dockerGb: 64 }, { cpus: 4 }).parallel, 4);
  assert.equal(autoSize({ totalGb: 128, freeGb: 100, dockerGb: 64 }, { cpus: 32, resources: { maxParallel: 5 } }).parallel, 5);
  assert.equal(autoSize({ totalGb: 128, freeGb: 100, dockerGb: 64 }, { cpus: 8 }).maxConcurrentPairs, 2, 'CPU-bound: room for a second pair per ticket');
});

test('memoryInfo: macOS counts inactive and purgeable pages; Docker MemTotal is read when docker answers', () => {
  const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 65536.\nPages purgeable: 0.\n';
  assert.equal(reclaimableBytes(vm), 65536 * 16384);
  const exec = (cmd) => (cmd === 'vm_stat' ? { status: 0, stdout: vm } : { status: 0, stdout: String(16 * 1024 ** 3) });
  const m = memoryInfo({ exec, platform: 'darwin', totalmem: 48 * 1024 ** 3, freemem: 2 * 1024 ** 3 });
  assert.deepEqual(m, { totalGb: 48, freeGb: 3, dockerGb: 16 });
  assert.equal(memoryInfo({ exec: () => ({ status: 1, stdout: '' }), platform: 'linux', totalmem: 1024 ** 3, freemem: 1024 ** 3 }).dockerGb, null);
});

test('parallelFor: a number wins; auto exports the derived limits; env overrides them', () => {
  const config = { implement: { parallel: 'auto', maxConcurrentPairs: 2 }, resources: {} };
  assert.equal(parallelFor(config, '3', { print: () => {} }), 3);
  const saved = { ...process.env };
  try {
    delete process.env.LSP_MAX_SERVERS;
    delete process.env.TESTSTACK_SLOTS;
    process.env.TESTSTACK_SLOTS = '2';
    const lines = [];
    const p = parallelFor(config, undefined, { mem: { totalGb: 48, freeGb: 30, dockerGb: 15.6 }, cpus: 14, print: (m) => lines.push(m) });
    assert.equal(p, 6);
    assert.match(lines[0], /Resources \(auto\): .*parallel 6/);
    assert.equal(process.env.TESTSTACK_SLOTS, '2', 'an explicit TESTSTACK_SLOTS wins');
    assert.ok(Number(process.env.LSP_MAX_SERVERS) >= 6);
    const c2 = applyResources({ implement: { maxConcurrentAgents: 6, maxConcurrentPairs: 2 } });
    assert.equal(c2.implement.maxConcurrentAgents, JSON.parse(process.env.IMPLEMENT_RESOURCES).maxConcurrentAgents);
    process.env.IMPLEMENT_MAX_PAIRS = '2';
    assert.equal(applyResources({ implement: {} }).implement.maxConcurrentPairs, 2, 'explicit env wins');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('waitForMemory: waits while free memory is below the reserve, then starts; no-op without auto sizing', async () => {
  const env = { IMPLEMENT_RESOURCES: JSON.stringify({ reserveGb: 6 }) };
  const free = [3, 4, 8];
  const waits = [];
  const waited = await waitForMemory({ resources: { waitPollSec: 5 } }, 'X-1', { env, mem: () => ({ freeGb: free.shift() }), wait: async (ms) => waits.push(ms) });
  assert.equal(waited, 10);
  assert.deepEqual(waits, [5000, 5000]);
  assert.equal(await waitForMemory({}, 'X-1', { env: {}, mem: () => ({ freeGb: 0 }) }), 0);
  assert.equal(await waitForMemory({ resources: { waitPollSec: 5, maxWaitSec: 5 } }, 'X-1', { env, mem: () => ({ freeGb: 1 }), wait: async () => {} }), 5, 'gives up after maxWaitSec');
});
