// The machine-wide agent semaphore (lock files shared by every process).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquire, holders } from '../lib/semaphore.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sem-'));

test('at most max holders; a released slot is reused', async () => {
  const dir = tmpDir();
  const a = await acquire(dir, 2);
  const b = await acquire(dir, 2);
  assert.ok(a && b);
  assert.equal(holders(dir).length, 2);
  assert.equal(await acquire(dir, 2, { deadline: Date.now() + 50, pollMs: 10 }), null, 'full until the deadline');
  const waiting = acquire(dir, 2, { deadline: Date.now() + 2000, pollMs: 10 });
  a();
  const c = await waiting;
  assert.ok(c, 'a waiter gets the released slot');
  b();
  c();
  assert.equal(holders(dir).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a slot held by a dead process is reclaimed', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'slot-0.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead' }));
  const release = await acquire(dir, 1, { deadline: Date.now() + 100, pollMs: 10 });
  assert.ok(release);
  release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('max 0 disables the limit', async () => {
  const release = await acquire('/nonexistent/never-created', 0);
  assert.equal(typeof release, 'function');
});
