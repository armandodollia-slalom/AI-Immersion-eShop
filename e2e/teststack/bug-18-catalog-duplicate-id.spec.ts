import { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { getTokens } from './auth-basket-helpers';
import { CATALOG_URL } from './ports';

// BUG-18: POST /api/catalog/items with an id that already exists must be a 409, not a 500.
// Plan: tests/plans/BUG-18-catalog-duplicate-id-500. Scenario: testing/scenarios/bug-18.
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

const count = async (request: APIRequestContext) => {
  const response = await request.get(`${API}/items?${V2}&pageSize=1&pageIndex=0`);
  expect(response.status()).toBe(200);
  return (await response.json()).count as number;
};

test.describe.configure({ mode: 'default' });

test.describe('BUG-18 catalog create with an existing id', () => {
  let auth: { Authorization: string };

  test.beforeEach(async () => {
    loadScenario('bug-18');
    const { access_token } = await getTokens('admin', 'Pass123$', 'openid profile catalog');
    auth = { Authorization: `Bearer ${access_token}` };
  });

  const create = (request: APIRequestContext, data: object) =>
    request.post(`${API}/items?${V2}`, { data, headers: auth });

  const locationId = (location: string | undefined) => {
    expect(location).toMatch(/^\/api\/catalog\/items\/\d+$/);
    return Number(location!.split('/').pop());
  };

  test('TC-BUG-18-01 create with an existing id returns 409', async ({ request }) => {
    const response = await test.step('POST create as admin with "id": 1', () => create(request, { ...BODY, id: 1 }));
    expect(response.status()).toBe(409);
    expect(response.status()).not.toBe(500);
  });

  test('TC-BUG-18-02 rejected duplicate create leaves the existing item and the count unchanged', async ({ request }) => {
    const before = await test.step('note the item count', () => count(request));
    expect(before).toBe(14);

    const response = await test.step('POST create as admin with "id": 1', () => create(request, { ...BODY, id: 1 }));
    expect(response.status()).toBe(409);

    await test.step('GET item 1 still has its original name', async () => {
      const get = await request.get(`${API}/items/1?${V1}`);
      expect(get.status()).toBe(200);
      expect((await get.json()).name).toBe('Edge 01 Penny Boot');
    });

    await test.step('item count is unchanged', async () => {
      expect(await count(request)).toBe(before);
    });
  });

  test('TC-BUG-18-03 create without an id still returns 201 with a generated id', async ({ request }) => {
    const response = await test.step('POST create as admin without an id', () => create(request, BODY));
    expect(response.status()).toBe(201);
    const id = locationId(response.headers()['location']);
    expect(id).toBeGreaterThan(14);

    await test.step('GET the created item', async () => {
      const get = await request.get(`${API}/items/${id}?${V1}`);
      expect(get.status()).toBe(200);
      expect((await get.json()).name).toBe('Edge 15 New Lantern');
    });
  });

  test('TC-BUG-18-04 create with id 0 is not treated as a duplicate', async ({ request }) => {
    const response = await test.step('POST create as admin with "id": 0', () => create(request, { ...BODY, id: 0 }));
    expect(response.status()).toBe(201);
    expect(locationId(response.headers()['location'])).toBeGreaterThan(14);
  });
});
