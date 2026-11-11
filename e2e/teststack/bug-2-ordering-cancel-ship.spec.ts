import { randomUUID } from 'crypto';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { ORDERING_URL } from './ports';
import { OrderDetails, V1, bearer, implicitToken } from './ordering-helpers';

// BUG-2: cancel is limited to the order's owner (404 otherwise); ship needs role Admin (403 for buyers).
// Plan: tests/plans/BUG-2-ordering-cancel-ship-no-ownership. Scenario: testing/scenarios/bug-2.
// TC-BUG-2-12 and TC-BUG-2-13 are static checks in tests/eShop.AppHost.UnitTests.
// The tests run in file order: the state-changing ones (04, 07) come after the ones that need the seeded state.
const API = `${ORDERING_URL}/api/orders`;
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const UNKNOWN_ORDER = 999;

let alice: string;
let bob: string;
let admin: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  loadScenario('bug-2');
  alice = await implicitToken('alice', 'ordering');
  bob = await implicitToken('bob', 'ordering');
  admin = await implicitToken('admin', 'ordering');
});

type Req = import('@playwright/test').APIRequestContext;

// Local copies of the shared helpers, built on the slot-aware ORDERING_URL from ports.ts.
const changeStatus = (request: Req, token: string, action: 'cancel' | 'ship', orderNumber: number, requestId: string = randomUUID()) =>
  request.put(`${API}/${action}?${V1}`, { headers: bearer(token, { 'x-requestid': requestId }), data: { orderNumber } });

const getOrder = async (request: Req, token: string, id: number): Promise<OrderDetails> => {
  const response = await request.get(`${API}/${id}?${V1}`, { headers: bearer(token) });
  expect(response.status(), `GET order ${id}`).toBe(200);
  return response.json();
};

const expectOrder = async (request: Req, token: string, id: number, status: string, description?: string) => {
  const order = await getOrder(request, token, id);
  expect(order.status, `order ${id} status`).toBe(status);
  if (description !== undefined) {
    expect(order.description, `order ${id} description`).toBe(description);
  }
};

test('TC-BUG-2-01 alice cannot cancel bob\'s order; 404 and the order is unchanged', async ({ request }) => {
  const response = await test.step('PUT cancel order 7 as alice', () => changeStatus(request, alice, 'cancel', 7));
  await test.step('the response is 404', async () => expect(response.status()).toBe(404));
  await test.step('order 7 is still Paid', () => expectOrder(request, bob, 7, 'Paid', 'Paid.'));
});

test('TC-BUG-2-02 bob cannot cancel alice\'s cancellable Submitted order', async ({ request }) => {
  const response = await test.step('PUT cancel order 1 as bob', () => changeStatus(request, bob, 'cancel', 1));
  await test.step('the response is 404', async () => expect(response.status()).toBe(404));
  await test.step('order 1 is still Submitted and not cancelled', async () => {
    const order = await getOrder(request, alice, 1);
    expect(order.status).toBe('Submitted');
    expect(order.description).not.toBe('The order was cancelled.');
  });
});

test('TC-BUG-2-03 cancelling an unknown order returns the same 404 as a not-owned order', async ({ request }) => {
  const unknown = await test.step('cancel order 999 as alice', () => changeStatus(request, alice, 'cancel', UNKNOWN_ORDER));
  const notOwned = await test.step('cancel bob\'s order 7 as alice', () => changeStatus(request, alice, 'cancel', 7));
  await test.step('both are 404', async () => {
    expect(unknown.status()).toBe(404);
    expect(notOwned.status()).toBe(404);
  });
  await test.step('status and body are identical', async () => {
    expect(await unknown.text()).toBe(await notOwned.text());
  });
});

test('TC-BUG-2-05 alice cannot ship bob\'s Paid order; 403 and the order is unchanged', async ({ request }) => {
  const response = await test.step('PUT ship order 7 as alice', () => changeStatus(request, alice, 'ship', 7));
  await test.step('the response is 403', async () => expect(response.status()).toBe(403));
  await test.step('order 7 is still Paid ("Paid.")', () => expectOrder(request, bob, 7, 'Paid', 'Paid.'));
});

test('TC-BUG-2-06 a buyer cannot ship even their own Paid order', async ({ request }) => {
  const response = await test.step('PUT ship order 4 as alice', () => changeStatus(request, alice, 'ship', 4));
  await test.step('the response is 403', async () => expect(response.status()).toBe(403));
  await test.step('order 4 is still Paid', () => expectOrder(request, alice, 4, 'Paid'));
});

test('TC-BUG-2-08 admin shipping an unknown order gets 404', async ({ request }) => {
  const response = await test.step('PUT ship order 999 as admin', () => changeStatus(request, admin, 'ship', UNKNOWN_ORDER));
  await test.step('the response is 404', async () => expect(response.status()).toBe(404));
  await test.step('orders 1-8 keep their scenario statuses', async () => {
    const expected = ['Submitted', 'Submitted', 'StockConfirmed', 'Paid', 'Shipped', 'Cancelled'];
    for (const [i, status] of expected.entries()) {
      await expectOrder(request, alice, i + 1, status);
    }
    await expectOrder(request, bob, 7, 'Paid');
    await expectOrder(request, bob, 8, 'Shipped');
  });
});

test('TC-BUG-2-09 a buyer shipping with an empty x-requestid gets 403, not 400', async ({ request }) => {
  const response = await test.step('PUT ship order 4 as alice with the empty GUID', () =>
    changeStatus(request, alice, 'ship', 4, EMPTY_GUID));
  await test.step('the response is 403', async () => expect(response.status()).toBe(403));
  await test.step('order 4 is still Paid', () => expectOrder(request, alice, 4, 'Paid'));
});

test('TC-BUG-2-10 admin shipping with an empty x-requestid still gets 400', async ({ request }) => {
  const response = await test.step('PUT ship order 4 as admin with the empty GUID', () =>
    changeStatus(request, admin, 'ship', 4, EMPTY_GUID));
  await test.step('the response is 400 with the request id message', async () => {
    expect(response.status()).toBe(400);
    expect(await response.json()).toBe('Empty GUID is not valid for request ID');
  });
  await test.step('order 4 is still Paid', () => expectOrder(request, alice, 4, 'Paid'));
});

test('TC-BUG-2-11 cancel and ship without a token return 401', async ({ request }) => {
  const cancel = await test.step('PUT cancel order 1 without Authorization', () =>
    request.put(`${API}/cancel?${V1}`, { headers: { 'x-requestid': randomUUID() }, data: { orderNumber: 1 } }));
  const ship = await test.step('PUT ship order 4 without Authorization', () =>
    request.put(`${API}/ship?${V1}`, { headers: { 'x-requestid': randomUUID() }, data: { orderNumber: 4 } }));
  await test.step('both are 401', async () => {
    expect(cancel.status()).toBe(401);
    expect(ship.status()).toBe(401);
  });
  await test.step('orders 1 and 4 keep Submitted and Paid', async () => {
    await expectOrder(request, alice, 1, 'Submitted');
    await expectOrder(request, alice, 4, 'Paid');
  });
});

test('TC-BUG-2-07 admin can ship any buyer\'s Paid order', async ({ request }) => {
  const response = await test.step('PUT ship order 7 as admin', () => changeStatus(request, admin, 'ship', 7));
  await test.step('the response is 200', async () => expect(response.status()).toBe(200));
  await test.step('order 7 is Shipped ("The order was shipped.")', () =>
    expectOrder(request, bob, 7, 'Shipped', 'The order was shipped.'));
});

test('TC-BUG-2-04 the owner can still cancel their own Submitted order', async ({ request }) => {
  const response = await test.step('PUT cancel order 1 as alice', () => changeStatus(request, alice, 'cancel', 1));
  await test.step('the response is 200', async () => expect(response.status()).toBe(200));
  await test.step('order 1 is Cancelled ("The order was cancelled.")', () =>
    expectOrder(request, alice, 1, 'Cancelled', 'The order was cancelled.'));
});
