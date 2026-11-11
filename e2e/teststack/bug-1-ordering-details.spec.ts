import { spawnSync } from 'child_process';
import path from 'path';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { ORDERING_URL } from './ports';
import { OrderDetails, V1, bearer, implicitToken } from './ordering-helpers';

// BUG-1: GET /api/orders/{id} returns an order only to its owning buyer; a foreign order is 404.
// Plan: tests/plans/BUG-1-ordering-order-details-idor. Scenario: testing/scenarios/bug-1.
// TC-BUG-1-08 (flow doc row) is a unit test in tests/eShop.AppHost.UnitTests.
const API = `${ORDERING_URL}/api/orders`;

let alice: string;
let bob: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  loadScenario('bug-1');
  alice = await implicitToken('alice', 'ordering');
  bob = await implicitToken('bob', 'ordering');
});

test('TC-BUG-1-01 buyer reads own order details', async ({ request }) => {
  const response = await test.step('GET /api/orders/4 as alice', () =>
    request.get(`${API}/4?${V1}`, { headers: bearer(alice) }));
  await test.step('the response is alice\'s order 4', async () => {
    expect(response.status()).toBe(200);
    const order: OrderDetails = await response.json();
    expect(order.orderNumber).toBe(4);
    expect(order.status).toBe('Paid');
    expect(order.street).toBe('221 Baker Street');
    expect(order.city).toBe('Boston');
    expect(order.orderItems.map((i) => i.unitPrice).sort((a, b) => a - b)).toEqual([69.99, 179.99]);
    expect(order.total).toBe(249.98);
  });
});

test('TC-BUG-1-02 second buyer reads own order details', async ({ request }) => {
  const response = await test.step('GET /api/orders/7 as bob', () =>
    request.get(`${API}/7?${V1}`, { headers: bearer(bob) }));
  await test.step('the response is bob\'s order 7', async () => {
    expect(response.status()).toBe(200);
    const order: OrderDetails = await response.json();
    expect(order.orderNumber).toBe(7);
    expect(order.street).toBe('2 Bob Road');
    expect(order.city).toBe('Portland');
    expect(order.total).toBe(599.97);
  });
});

test('TC-BUG-1-03 alice cannot read bob\'s order; response is 404 with no order data', async ({ request }) => {
  const response = await test.step('GET /api/orders/7 as alice', () =>
    request.get(`${API}/7?${V1}`, { headers: bearer(alice) }));
  await test.step('the status is 404 and the body leaks nothing', async () => {
    expect(response.status()).toBe(404);
    const body = await response.text();
    for (const leaked of ['2 Bob Road', 'Portland', 'VenturePro GPS Watch', '599.97']) {
      expect(body).not.toContain(leaked);
    }
  });
});

test('TC-BUG-1-04 bob cannot read alice\'s order', async ({ request }) => {
  const response = await test.step('GET /api/orders/4 as bob', () =>
    request.get(`${API}/4?${V1}`, { headers: bearer(bob) }));
  await test.step('the status is 404 and the body leaks nothing', async () => {
    expect(response.status()).toBe(404);
    const body = await response.text();
    expect(body).not.toContain('Boston');
    expect(body).not.toContain('249.98');
  });
});

test('TC-BUG-1-07 ordering API spec passes with the fixme removed from the order-details test', async ({ request }) => {
  test.setTimeout(10 * 60 * 1000);
  // the stack must be serving before the nested run starts re-seeding it
  await expect
    .poll(async () => (await request.get(`${API}/4?${V1}`, { headers: bearer(alice) })).status(), { timeout: 60_000 })
    .toBe(200);
  const runSpec = () =>
    spawnSync(
      'npx',
      ['playwright', 'test', '-c', 'playwright.teststack.config.ts', '--project', 'scenarios', '--no-deps',
        '--reporter=json', 'e2e/teststack/ordering-api.spec.ts'],
      { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, E2E_KEEP_VIDEOS: '' } },
    );
  // the nested run re-seeds the stack and restarts ordering-api; retry up to twice if it was still coming up
  const run = await test.step('run ordering-api.spec.ts', async () => {
    let result = runSpec();
    for (let attempt = 1; attempt < 3 && result.status !== 0; attempt++) {
      // wait until the restarted ordering-api serves the seeded order again before retrying
      await expect
        .poll(async () => (await request.get(`${API}/4?${V1}`, { headers: bearer(alice) }).catch(() => null))?.status(), { timeout: 60_000 })
        .toBe(200);
      result = runSpec();
    }
    return result;
  });
  await test.step('the run exits 0 and the details test passed, not skipped', () => {
    const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
    const failures = JSON.stringify(
      (report.errors ?? []).concat(
        JSON.stringify(report.suites).match(/"error":\{"message":"[^"]{0,600}/g) ?? [],
      ),
    );
    expect(run.status, failures).toBe(0);
    const specs: { title: string; ok: boolean; tests: { status: string; results: { status: string }[] }[] }[] = [];
    const collect = (suite: any) => {
      specs.push(...(suite.specs ?? []));
      (suite.suites ?? []).forEach(collect);
    };
    report.suites.forEach(collect);
    const target = specs.find((s) => s.title === 'a buyer cannot read another buyer\'s order details');
    expect(target, 'the order-details test is in the report').toBeDefined();
    expect(target!.tests.map((t) => t.status)).toEqual(['expected']);
    expect(target!.tests[0].results.map((r) => r.status)).toEqual(['passed']);
    expect(specs.filter((s) => !s.ok)).toEqual([]);
    expect(report.stats.unexpected).toBe(0);
  });
});
