import { APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { ORDERING_URL } from './ports';
import { ALICE_ID, V1, bearer, implicitToken } from './ordering-helpers';

// BUG-15: POST /api/orders/draft answers 400 (validation problem) for a missing body or null items.
// Plan: tests/plans/BUG-15-ordering-draft-without-body-500. Scenario: testing/scenarios/bug-15.
const API = `${ORDERING_URL}/api/orders`;
const DRAFT = `${API}/draft?${V1}`;

let alice: string;

test.beforeAll(async () => {
  loadScenario('bug-15');
  alice = await implicitToken('alice', 'ordering');
});

const aliceOrderNumbers = async (request: APIRequestContext) => {
  const response = await request.get(`${API}?${V1}`, { headers: bearer(alice) });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { orderNumber: number }[]).map((o) => o.orderNumber).sort((a, b) => a - b);
};

type Problem = { status: number; errors: Record<string, string[]> };

const expectProblem = async (response: APIResponse): Promise<Problem> => {
  expect(response.status()).toBe(400);
  expect(response.headers()['content-type']).toContain('application/problem+json');
  const body = (await response.json()) as Problem;
  expect(body.status).toBe(400);
  return body;
};

test('TC-BUG-15-01 a draft without a body is rejected with 400 and creates no order', async ({ request }) => {
  const response = await test.step('POST /api/orders/draft as alice with no body and no Content-Type', () =>
    request.post(DRAFT, { headers: bearer(alice) }));
  await test.step('status is 400 with a validation problem on the empty key', async () => {
    const problem = await expectProblem(response);
    expect(Object.keys(problem.errors)).toEqual(['']);
    expect(problem.errors['']).toHaveLength(1);
    expect(problem.errors[''][0]).not.toBe('');
  });
  await test.step('alice still has exactly 6 orders', async () => {
    expect(await aliceOrderNumbers(request)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

test('TC-BUG-15-02 a draft with items null is rejected with 400 on the Items key', async ({ request }) => {
  const response = await test.step('POST /api/orders/draft as alice with items null', () =>
    request.post(DRAFT, { headers: bearer(alice), data: { buyerId: ALICE_ID, items: null } }));
  await test.step('status is 400 with exactly one message on Items', async () => {
    const problem = await expectProblem(response);
    expect(Object.keys(problem.errors)).toEqual(['Items']);
    expect(problem.errors.Items).toHaveLength(1);
    expect(problem.errors.Items[0]).not.toBe('');
  });
});

test('TC-BUG-15-03 a draft with items [] still returns 200 and an empty draft', async ({ request }) => {
  const response = await test.step('POST /api/orders/draft as alice with items []', () =>
    request.post(DRAFT, { headers: bearer(alice), data: { buyerId: ALICE_ID, items: [] } }));
  await test.step('status is 200 and the draft is empty', async () => {
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ orderItems: [], total: 0 });
  });
});

test('TC-BUG-15-04 a draft with items still returns 200 and the computed total', async ({ request }) => {
  const item = { productName: 'Summit Pro Harness', oldUnitPrice: 0, pictureUrl: '' };
  const response = await test.step('POST /api/orders/draft as alice with the two basket items', () =>
    request.post(DRAFT, {
      headers: bearer(alice),
      data: {
        buyerId: ALICE_ID,
        items: [
          { ...item, id: globalThis.crypto.randomUUID(), productId: 2, unitPrice: 89.99, quantity: 2 },
          { ...item, id: globalThis.crypto.randomUUID(), productId: 10, productName: 'Trailblazer Bike Helmet', unitPrice: 59.99, quantity: 1 },
        ],
      },
    }));
  await test.step('status is 200 with two items and the total', async () => {
    expect(response.status()).toBe(200);
    const draft = await response.json();
    expect(draft.orderItems).toHaveLength(2);
    expect(draft.orderItems[0]).toMatchObject({ productId: 2, units: 2, unitPrice: 89.99, discount: 0 });
    expect(draft.total).toBeCloseTo(239.97, 2);
  });
  await test.step('alice still has exactly 6 orders', async () => {
    expect(await aliceOrderNumbers(request)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
