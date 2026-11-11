import { randomUUID } from 'crypto';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { ORDERING_URL } from './ports';
import { ALICE_ID, BOB_ID, V1, bearer, implicitToken } from './ordering-helpers';

// BUG-3: POST /api/orders creates the order for the token's buyer; a userId in the body is ignored.
// Plan: tests/plans/BUG-3-ordering-create-order-trusts-userid. Scenario: testing/scenarios/bug-3.
// TC-BUG-3-05 (flow doc row) is a unit test in tests/eShop.AppHost.UnitTests.
const API = `${ORDERING_URL}/api/orders`;

const createOrderBody = (userId: string, userName: string) => ({
  userId,
  userName,
  city: 'Redmond',
  street: '1 Microsoft Way',
  state: 'WA',
  country: 'U.S.',
  zipCode: '98052',
  cardNumber: '4012888888881881',
  cardHolderName: 'Test Holder',
  cardExpiration: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
  cardSecurityNumber: '123',
  cardTypeId: 2,
  buyer: userId,
  items: [
    { id: randomUUID(), productId: 2, productName: 'Summit Pro Harness', unitPrice: 89.99, oldUnitPrice: 0, quantity: 2, pictureUrl: '' },
  ],
});

let alice: string;
let bob: string;

// Each test creates one order, so the counts depend on the order of the tests.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  loadScenario('bug-3');
  alice = await implicitToken('alice', 'ordering');
  bob = await implicitToken('bob', 'ordering');
});

const count = async (request: import('@playwright/test').APIRequestContext, token: string) => {
  const response = await request.get(`${API}?${V1}`, { headers: bearer(token) });
  expect(response.status()).toBe(200);
  return ((await response.json()) as unknown[]).length;
};

const createOrder = (request: import('@playwright/test').APIRequestContext, token: string, userId: string, userName: string) =>
  request.post(`${API}?${V1}`, {
    headers: bearer(token, { 'x-requestid': randomUUID() }),
    data: createOrderBody(userId, userName),
  });

test('TC-BUG-3-01 bob posts an order with alice\'s userId; the order is created for bob only', async ({ request }) => {
  await test.step('bob has 2 orders', async () => expect(await count(request, bob)).toBe(2));
  const response = await test.step('POST /api/orders as bob with userId = alice', () =>
    createOrder(request, bob, ALICE_ID, 'alice'));
  await test.step('the response is 200', async () => expect(response.status()).toBe(200));
  await test.step('alice still has exactly 6 orders', async () => expect(await count(request, alice)).toBe(6));
  await test.step('bob has 3 orders', async () => expect(await count(request, bob)).toBe(3));
});

test('TC-BUG-3-02 alice posts an order with bob\'s userId; the order is created for alice only', async ({ request }) => {
  await test.step('alice has 6 orders and bob has 3 (after TC-BUG-3-01)', async () => {
    expect(await count(request, alice)).toBe(6);
    expect(await count(request, bob)).toBe(3);
  });
  const response = await test.step('POST /api/orders as alice with userId = bob', () =>
    createOrder(request, alice, BOB_ID, 'bob'));
  await test.step('the response is 200', async () => expect(response.status()).toBe(200));
  await test.step('alice has 7 orders and bob is unchanged at 3', async () => {
    expect(await count(request, alice)).toBe(7);
    expect(await count(request, bob)).toBe(3);
  });
});

test('TC-BUG-3-03 bob posts an order with his own userId; the order is created for bob', async ({ request }) => {
  await test.step('alice has 7 orders and bob has 3 (after TC-BUG-3-02)', async () => {
    expect(await count(request, alice)).toBe(7);
    expect(await count(request, bob)).toBe(3);
  });
  const response = await test.step('POST /api/orders as bob with userId = bob', () =>
    createOrder(request, bob, BOB_ID, 'bob'));
  await test.step('the response is 200', async () => expect(response.status()).toBe(200));
  await test.step('bob has 4 orders and alice is unchanged at 7', async () => {
    expect(await count(request, bob)).toBe(4);
    expect(await count(request, alice)).toBe(7);
  });
});

test('TC-BUG-3-04 create order without a token is rejected and creates nothing', async ({ request }) => {
  const before = await count(request, alice);
  const response = await test.step('POST /api/orders without Authorization', () =>
    request.post(`${API}?${V1}`, {
      headers: { 'x-requestid': randomUUID() },
      data: createOrderBody(ALICE_ID, 'alice'),
    }));
  await test.step('the response is 401', async () => expect(response.status()).toBe(401));
  await test.step('alice\'s order count is unchanged', async () => expect(await count(request, alice)).toBe(before));
});
