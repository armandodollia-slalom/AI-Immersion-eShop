import { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { getTokens } from './auth-basket-helpers';
import { CATALOG_URL } from './ports';

// BUG-20: PUT /api/catalog/items/{id}?api-version=2.0 with a body id different from the route id must be a 400, not a 500.
// Plan: tests/plans/BUG-20-catalog-v2-put-id-mismatch-500. Scenario: testing/scenarios/bug-20.
const API = `${CATALOG_URL}/api/catalog`;
const V1 = 'api-version=1.0';
const V2 = 'api-version=2.0';

const BODY = {
  name: 'Edge 15 New Lantern',
  description: 'Created by the admin API test.',
  price: 42.5,
  pictureFileName: '7.webp',
  catalogTypeId: 3,
  catalogBrandId: 2,
  availableStock: 12,
  restockThreshold: 2,
  maxStockThreshold: 50,
};

test.describe.configure({ mode: 'default' });

test.describe('BUG-20 catalog v2 PUT with a mismatching body id', () => {
  let auth: { Authorization: string };

  test.beforeEach(async () => {
    loadScenario('bug-20');
    const { access_token } = await getTokens('admin', 'Pass123$', 'openid profile catalog');
    auth = { Authorization: `Bearer ${access_token}` };
  });

  const put = (request: APIRequestContext, routeId: number, data: object) =>
    request.put(`${API}/items/${routeId}?${V2}`, { data, headers: auth });

  const get = async (request: APIRequestContext, id: number) => {
    const response = await request.get(`${API}/items/${id}?${V1}`);
    expect(response.status()).toBe(200);
    return response.json();
  };

  test('TC-BUG-20-01 v2 PUT with body id 2 on route id 1 returns 400 with the mismatch message', async ({ request }) => {
    const response = await test.step('PUT items/1 with body "id": 2', () => put(request, 1, { ...BODY, id: 2 }));
    expect(response.status()).toBe(400);
    expect(response.status()).not.toBe(500);
    const problem = await response.json();
    expect(problem.status).toBe(400);
    expect(problem.detail).toBe('Route id and body id must match');
  });

  test('TC-BUG-20-02 rejected mismatch PUT leaves items 1 and 2 unchanged', async ({ request }) => {
    const response = await test.step('PUT items/1 with body "id": 2', () => put(request, 1, { ...BODY, id: 2 }));
    expect(response.status()).toBe(400);

    await test.step('GET item 1 is unchanged', async () => {
      const item = await get(request, 1);
      expect(item.id).toBe(1);
      expect(item.name).toBe('Edge 01 Penny Boot');
      expect(item.price).toBe(0.01);
    });

    await test.step('GET item 2 is unchanged', async () => {
      const item = await get(request, 2);
      expect(item.id).toBe(2);
      expect(item.name).toBe('Edge 02 Trail Boot');
      expect(item.price).toBe(59.5);
    });

    await test.step('item count is still 14', async () => {
      const list = await request.get(`${API}/items?${V1}`);
      expect(list.status()).toBe(200);
      expect((await list.json()).count).toBe(14);
    });
  });

  test('TC-BUG-20-03 v2 PUT with a body id equal to the route id still returns 201 and updates the item', async ({ request }) => {
    const response = await test.step('PUT items/4 with body "id": 4', () => put(request, 4, { ...BODY, id: 4 }));
    expect(response.status()).toBe(201);

    await test.step('GET item 4 has the new values', async () => {
      const item = await get(request, 4);
      expect(item.id).toBe(4);
      expect(item.name).toBe('Edge 15 New Lantern');
      expect(item.price).toBe(42.5);
    });
  });

  test('TC-BUG-20-04 v2 PUT without a body id uses the route id', async ({ request }) => {
    const response = await test.step('PUT items/7 without an id field', () => put(request, 7, BODY));
    expect(response.status()).toBe(201);

    await test.step('GET item 7 has the new values', async () => {
      const item = await get(request, 7);
      expect(item.id).toBe(7);
      expect(item.name).toBe('Edge 15 New Lantern');
      expect(item.price).toBe(42.5);
    });
  });
});
