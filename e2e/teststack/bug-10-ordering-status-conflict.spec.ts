import { randomUUID } from 'crypto';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { ORDERING_URL } from './ports';
import { OrderDetails, V1, bearer, implicitToken } from './ordering-helpers';

// BUG-10: a broken order status rule answers 409 ProblemDetails (not 500); unknown/not-owned stay 404, non-admin ship 403.
// Plan: tests/plans/BUG-10-ordering-domain-errors-return-500. Scenario: testing/scenarios/bug-10.
// Tests run in file order: the state-changing ones (12, 13) come last.
const API = `${ORDERING_URL}/api/orders`;
const RULE = (from: string, to: string) => `Is not possible to change the order status from ${from} to ${to}.`;

let alice: string;
let bob: string;
let admin: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  loadScenario('bug-10');
  alice = await implicitToken('alice', 'ordering');
  bob = await implicitToken('bob', 'ordering');
  admin = await implicitToken('admin', 'ordering');
});

type Req = import('@playwright/test').APIRequestContext;

const changeStatus = (request: Req, token: string, action: 'cancel' | 'ship', orderNumber: number, requestId: string = randomUUID()) =>
  request.put(`${API}/${action}?${V1}`, { headers: bearer(token, { 'x-requestid': requestId }), data: { orderNumber } });

const getOrder = async (request: Req, token: string, id: number): Promise<OrderDetails> => {
  const response = await request.get(`${API}/${id}?${V1}`, { headers: bearer(token) });
  expect(response.status(), `GET order ${id}`).toBe(200);
  return response.json();
};

const expectConflict = async (response: import('@playwright/test').APIResponse, detail: string) => {
  expect(response.status()).toBe(409);
  expect(response.headers()['content-type']).toContain('application/problem+json');
  const body = await response.json();
  expect(body.status).toBe(409);
  expect(body.detail).toBe(detail);
  return body;
};

test('TC-BUG-10-01 cancelling a Shipped order returns 409 with the rule message', async ({ request }) => {
  const response = await test.step('PUT cancel order 5 as alice', () => changeStatus(request, alice, 'cancel', 5));
  await test.step('409 problem+json with the rule message', async () => {
    await expectConflict(response, RULE('Shipped', 'Cancelled'));
    expect(await response.text()).not.toContain('Cancel order failed to process.');
  });
});

test('TC-BUG-10-02 cancelling a Paid order returns 409 with the rule message', async ({ request }) => {
  const response = await test.step('PUT cancel order 4 as alice', () => changeStatus(request, alice, 'cancel', 4));
  await test.step('409 with the rule message', () => expectConflict(response, RULE('Paid', 'Cancelled')));
});

test('TC-BUG-10-03 shipping a Submitted order returns 409 with the rule message', async ({ request }) => {
  const response = await test.step('PUT ship order 2 as admin', () => changeStatus(request, admin, 'ship', 2));
  await test.step('409 with the rule message', () => expectConflict(response, RULE('Submitted', 'Shipped')));
});

test('TC-BUG-10-04 shipping a Cancelled order returns 409 with the rule message', async ({ request }) => {
  const response = await test.step('PUT ship order 6 as admin', () => changeStatus(request, admin, 'ship', 6));
  await test.step('409 with the rule message', () => expectConflict(response, RULE('Cancelled', 'Shipped')));
});

test('TC-BUG-10-05 shipping an already Shipped order returns 409 with the rule message', async ({ request }) => {
  const response = await test.step('PUT ship order 5 as admin', () => changeStatus(request, admin, 'ship', 5));
  await test.step('409 with the rule message', () => expectConflict(response, RULE('Shipped', 'Shipped')));
});

test('TC-BUG-10-06 a rejected status change leaves the order unchanged', async ({ request }) => {
  await test.step('cancel order 5 is rejected', async () =>
    expect((await changeStatus(request, alice, 'cancel', 5)).status()).toBe(409));
  await test.step('cancel order 4 is rejected', async () =>
    expect((await changeStatus(request, alice, 'cancel', 4)).status()).toBe(409));
  await test.step('orders 5 and 4 keep Shipped and Paid', async () => {
    expect((await getOrder(request, alice, 5)).status).toBe('Shipped');
    expect((await getOrder(request, alice, 4)).status).toBe('Paid');
  });
});

test('TC-BUG-10-07 retrying a rejected change with the same x-requestid returns 409 again', async ({ request }) => {
  const id = randomUUID();
  const first = await test.step('first cancel of order 5', () => changeStatus(request, alice, 'cancel', 5, id));
  const second = await test.step('same request again', () => changeStatus(request, alice, 'cancel', 5, id));
  await test.step('both are 409 with the rule message', async () => {
    await expectConflict(first, RULE('Shipped', 'Cancelled'));
    await expectConflict(second, RULE('Shipped', 'Cancelled'));
  });
  await test.step('order 5 is still Shipped', async () => expect((await getOrder(request, alice, 5)).status).toBe('Shipped'));
});

test('TC-BUG-10-08 cancelling an unknown order returns 404', async ({ request }) => {
  const response = await test.step('PUT cancel order 999 as alice', () => changeStatus(request, alice, 'cancel', 999));
  await test.step('the response is 404', async () => expect(response.status()).toBe(404));
});

test('TC-BUG-10-09 shipping an unknown order returns 404', async ({ request }) => {
  const response = await test.step('PUT ship order 999 as admin', () => changeStatus(request, admin, 'ship', 999));
  await test.step('the response is 404', async () => expect(response.status()).toBe(404));
});

test('TC-BUG-10-10 cancelling another buyer\'s order returns 404, not 409', async ({ request }) => {
  const response = await test.step('PUT cancel order 7 as alice', () => changeStatus(request, alice, 'cancel', 7));
  await test.step('404 without the rule message', async () => {
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain('Is not possible to change the order status');
  });
  await test.step('order 7 is still Paid for bob', async () => expect((await getOrder(request, bob, 7)).status).toBe('Paid'));
});

test('TC-BUG-10-11 shipping as a non-Admin still returns 403', async ({ request }) => {
  const response = await test.step('PUT ship order 4 as alice', () => changeStatus(request, alice, 'ship', 4));
  await test.step('the response is 403', async () => expect(response.status()).toBe(403));
  await test.step('order 4 is still Paid', async () => expect((await getOrder(request, alice, 4)).status).toBe('Paid'));
});

test('TC-BUG-10-12 cancelling a Submitted order still returns 200 and cancels it', async ({ request }) => {
  const response = await test.step('PUT cancel order 1 as alice', () => changeStatus(request, alice, 'cancel', 1));
  await test.step('the response is 200', async () => expect(response.status()).toBe(200));
  await test.step('order 1 is Cancelled', async () => expect((await getOrder(request, alice, 1)).status).toBe('Cancelled'));
});

test('TC-BUG-10-13 shipping a Paid order as admin still returns 200 and ships it', async ({ request }) => {
  const response = await test.step('PUT ship order 7 as admin', () => changeStatus(request, admin, 'ship', 7));
  await test.step('the response is 200', async () => expect(response.status()).toBe(200));
  await test.step('order 7 is Shipped for bob', async () => expect((await getOrder(request, bob, 7)).status).toBe('Shipped'));
});
