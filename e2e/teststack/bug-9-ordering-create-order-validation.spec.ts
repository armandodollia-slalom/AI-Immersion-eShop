import { randomUUID } from 'crypto';
import { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { ORDERING_URL } from './ports';
import { ALICE_ID, V1, bearer, implicitToken } from './ordering-helpers';

// BUG-9: POST /api/orders answers 400 (validation problem) when the create-order command fails validation.
// Plan: tests/plans/BUG-9-ordering-create-order-returns-200-on-failure. Scenario: testing/scenarios/bug-9.
const API = `${ORDERING_URL}/api/orders`;

type Body = Record<string, unknown>;

const validBody = (overrides: Body = {}): Body => ({
  userId: ALICE_ID,
  userName: 'alice',
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
  buyer: ALICE_ID,
  items: [
    { id: randomUUID(), productId: 2, productName: 'Summit Pro Harness', unitPrice: 89.99, oldUnitPrice: 0, quantity: 2, pictureUrl: '' },
  ],
  ...overrides,
});

let alice: string;
let bob: string;

test.beforeEach(async () => {
  loadScenario('bug-9');
  alice = await implicitToken('alice', 'ordering');
  bob = await implicitToken('bob', 'ordering');
});

const post = (request: APIRequestContext, body: Body, requestId: string = randomUUID()) =>
  request.post(`${API}?${V1}`, { headers: bearer(alice, { 'x-requestid': requestId }), data: body });

const orders = async (request: APIRequestContext, token: string) => {
  const response = await request.get(`${API}?${V1}`, { headers: bearer(token) });
  expect(response.status()).toBe(200);
  return (await response.json()) as { orderNumber: number; status: string }[];
};

const numbers = (list: { orderNumber: number }[]) => list.map((o) => o.orderNumber).sort((a, b) => a - b);

type Problem = { status: number; errors: Record<string, string[]> };

const expectValidationProblem = async (response: import('@playwright/test').APIResponse): Promise<Problem> => {
  expect(response.status()).toBe(400);
  expect(response.headers()['content-type']).toContain('application/problem+json');
  const body = (await response.json()) as Problem;
  expect(body.status).toBe(400);
  return body;
};

const expectAliceHasSix = async (request: APIRequestContext) =>
  expect(numbers(await orders(request, alice))).toEqual([1, 2, 3, 4, 5, 6]);

test('TC-BUG-9-01 an order with an empty items list is rejected with 400 and the validator message', async ({ request }) => {
  const response = await test.step('POST /api/orders as alice with items []', () => post(request, validBody({ items: [] })));
  await test.step('status is 400 with a validation problem', async () => {
    const problem = await expectValidationProblem(response);
    expect(problem.errors).toEqual({ OrderItems: ['No order items found'] });
  });
});

test('TC-BUG-9-02 a rejected order creates no order', async ({ request }) => {
  const before = await test.step('alice lists her orders', async () => {
    const list = await orders(request, alice);
    expect(numbers(list)).toEqual([1, 2, 3, 4, 5, 6]);
    return list;
  });
  await test.step('POST the empty-items request as alice; it returns 400', async () => {
    expect((await post(request, validBody({ items: [] }))).status()).toBe(400);
  });
  await test.step('alice still has exactly the same 6 orders', async () => {
    expect(await orders(request, alice)).toEqual(before);
  });
  await test.step('bob still has 2 orders (7 and 8)', async () => {
    expect(numbers(await orders(request, bob))).toEqual([7, 8]);
  });
});

test('TC-BUG-9-03 several validation failures are returned together, grouped by property', async ({ request }) => {
  const response = await test.step('POST /api/orders as alice with empty city and zipCode', () =>
    post(request, validBody({ city: '', zipCode: '' })));
  await test.step('status is 400 with City and ZipCode errors only', async () => {
    const problem = await expectValidationProblem(response);
    expect(Object.keys(problem.errors).sort()).toEqual(['City', 'ZipCode']);
    expect(problem.errors.City).toHaveLength(1);
    expect(problem.errors.City[0]).toContain('City');
    expect(problem.errors.ZipCode).toHaveLength(1);
    expect(problem.errors.ZipCode[0]).toContain('Zip Code');
    expect(problem.errors).not.toHaveProperty('OrderItems');
  });
  await test.step('alice still has 6 orders', () => expectAliceHasSix(request));
});

test('TC-BUG-9-04 an expired card is rejected with 400 and the expiration message', async ({ request }) => {
  const response = await test.step('POST /api/orders as alice with a card that expired yesterday', () =>
    post(request, validBody({ cardExpiration: new Date(Date.now() - 24 * 3600 * 1000).toISOString() })));
  await test.step('status is 400 with the CardExpiration message', async () => {
    const problem = await expectValidationProblem(response);
    expect(problem.errors).toHaveProperty('CardExpiration');
    expect(problem.errors.CardExpiration.join(' ')).toContain('Please specify a valid card expiration date');
  });
  await test.step('alice still has 6 orders', () => expectAliceHasSix(request));
});

test('TC-BUG-9-05 a card number of 11 characters is rejected with 400', async ({ request }) => {
  const response = await test.step('POST /api/orders as alice with an 11-digit card number', () =>
    post(request, validBody({ cardNumber: '40128888888' })));
  await test.step('status is 400 with a CardNumber error', async () => {
    const problem = await expectValidationProblem(response);
    expect(problem.errors).toHaveProperty('CardNumber');
    expect(problem.errors.CardNumber.length).toBeGreaterThanOrEqual(1);
  });
  await test.step('alice still has 6 orders', () => expectAliceHasSix(request));
});

test('TC-BUG-9-06 a card number of 12 characters is accepted with 200', async ({ request }) => {
  const response = await test.step('POST /api/orders as alice with a 12-digit card number', () =>
    post(request, validBody({ cardNumber: '401288888888' })));
  await test.step('status is 200', async () => expect(response.status()).toBe(200));
  await test.step('alice has 7 orders', async () => expect(await orders(request, alice)).toHaveLength(7));
});

test('TC-BUG-9-07 a card security number of 2 characters is rejected with 400', async ({ request }) => {
  const response = await test.step('POST /api/orders as alice with security number "12"', () =>
    post(request, validBody({ cardSecurityNumber: '12' })));
  await test.step('status is 400 with a CardSecurityNumber error', async () => {
    const problem = await expectValidationProblem(response);
    expect(problem.errors).toHaveProperty('CardSecurityNumber');
    expect(problem.errors.CardSecurityNumber.length).toBeGreaterThanOrEqual(1);
  });
  await test.step('alice still has 6 orders', () => expectAliceHasSix(request));
});

test('TC-BUG-9-08 an empty x-requestid still returns 400 "RequestId is missing."', async ({ request }) => {
  const response = await test.step('POST /api/orders as alice with an empty-GUID x-requestid', () =>
    post(request, validBody(), '00000000-0000-0000-0000-000000000000'));
  await test.step('status is 400 and the body is the RequestId message', async () => {
    expect(response.status()).toBe(400);
    expect(await response.json()).toBe('RequestId is missing.');
  });
  await test.step('alice still has 6 orders', () => expectAliceHasSix(request));
});

test('TC-BUG-9-09 a valid order is still created with 200', async ({ request }) => {
  const response = await test.step('POST a valid order as alice', () => post(request, validBody()));
  await test.step('status is 200', async () => expect(response.status()).toBe(200));
  await test.step('alice has 7 orders, the new one Submitted, and bob still has 2', async () => {
    const list = await orders(request, alice);
    expect(list).toHaveLength(7);
    const created = list.filter((o) => o.orderNumber > 8);
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe('Submitted');
    expect(await orders(request, bob)).toHaveLength(2);
  });
});
