import { APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { getTokens } from './auth-basket-helpers';
import { CATALOG_URL } from './ports';

// BUG-19: unknown catalogBrandId / catalogTypeId on create or update must be a 400 validation problem, not a 500.
// Plan: tests/plans/BUG-19-catalog-unknown-brand-type-500. Scenario: testing/scenarios/bug-19.
const API = `${CATALOG_URL}/api/catalog`;
const V1 = 'api-version=1.0';
const V2 = 'api-version=2.0';

const newItem = {
  name: 'Edge 15 New Lantern',
  description: 'Edge',
  price: 42.5,
  pictureFileName: '7.webp',
  catalogTypeId: 3,
  catalogBrandId: 2,
  availableStock: 12,
  restockThreshold: 2,
  maxStockThreshold: 50,
};

const item1Update = {
  id: 1,
  name: 'Edge 01 Penny Boot',
  description: 'Edge',
  price: 42.5,
  pictureFileName: '1.webp',
  catalogTypeId: 1,
  catalogBrandId: 1,
  availableStock: 10,
  restockThreshold: 5,
  maxStockThreshold: 100,
};

const BRAND_999 = 'Catalog brand with id 999 does not exist.';
const TYPE_999 = 'Catalog type with id 999 does not exist.';

const errorsOf = async (response: APIResponse) => {
  expect(response.status()).toBe(400);
  expect(response.headers()['content-type']).toContain('application/problem+json');
  return (await response.json()).errors as Record<string, string[]>;
};

const messages = (errors: Record<string, string[]>, key: string) =>
  Object.entries(errors).filter(([k]) => k.toLowerCase() === key.toLowerCase()).flatMap(([, v]) => v);

const hasKey = (errors: Record<string, string[]>, key: string) =>
  Object.keys(errors).some(k => k.toLowerCase() === key.toLowerCase());

test.describe.configure({ mode: 'default' });

test.describe('BUG-19 catalog unknown brand or type ids', () => {
  let auth: { Authorization: string };

  test.beforeEach(async () => {
    loadScenario('bug-19');
    const { access_token } = await getTokens('admin', 'Pass123$', 'openid profile catalog');
    auth = { Authorization: `Bearer ${access_token}` };
  });

  const create = (request: APIRequestContext, data: unknown) =>
    request.post(`${API}/items?${V2}`, { data, headers: auth });
  const putV2 = (request: APIRequestContext, id: number, data: unknown) =>
    request.put(`${API}/items/${id}?${V2}`, { data, headers: auth });
  const putV1 = (request: APIRequestContext, data: unknown) =>
    request.put(`${API}/items?${V1}`, { data, headers: auth });
  const list = async (request: APIRequestContext) => {
    const response = await request.get(`${API}/items?${V2}&pageSize=50`);
    expect(response.status()).toBe(200);
    return response.json();
  };

  test('TC-BUG-19-01 create with an unknown brand id returns 400 naming the id', async ({ request }) => {
    const response = await test.step('POST create with catalogBrandId 999', () => create(request, { ...newItem, catalogBrandId: 999 }));
    const errors = await errorsOf(response);
    expect(messages(errors, 'CatalogBrandId')).toContain(BRAND_999);
    expect(hasKey(errors, 'CatalogTypeId')).toBe(false);
  });

  test('TC-BUG-19-02 create with an unknown type id returns 400 naming the id', async ({ request }) => {
    const response = await test.step('POST create with catalogTypeId 999', () => create(request, { ...newItem, catalogTypeId: 999 }));
    const errors = await errorsOf(response);
    expect(messages(errors, 'CatalogTypeId')).toContain(TYPE_999);
    expect(hasKey(errors, 'CatalogBrandId')).toBe(false);
  });

  test('TC-BUG-19-03 create with unknown brand and type reports both errors in one 400', async ({ request }) => {
    const response = await test.step('POST create with brand 998 and type 999', () =>
      create(request, { ...newItem, catalogTypeId: 999, catalogBrandId: 998 }));
    const errors = await errorsOf(response);
    expect(messages(errors, 'CatalogBrandId')).toContain('Catalog brand with id 998 does not exist.');
    expect(messages(errors, 'CatalogTypeId')).toContain(TYPE_999);
  });

  test('TC-BUG-19-04 create with empty name and unknown brand reports both fields', async ({ request }) => {
    const response = await test.step('POST create with empty name and brand 999', () =>
      create(request, { ...newItem, name: '', catalogBrandId: 999 }));
    const errors = await errorsOf(response);
    expect(hasKey(errors, 'Name')).toBe(true);
    expect(messages(errors, 'CatalogBrandId')).toContain(BRAND_999);
  });

  test('TC-BUG-19-05 rejected create with unknown ids stores no item', async ({ request }) => {
    const before = await test.step('GET the item list and note the count', () => list(request));
    expect(before.count).toBe(14);
    const response = await test.step('POST create with catalogTypeId 999', () => create(request, { ...newItem, catalogTypeId: 999 }));
    expect(response.status()).toBe(400);
    await test.step('the item list is unchanged', async () => {
      const after = await list(request);
      expect(after.count).toBe(14);
      expect(after.data.map((i: { name: string }) => i.name)).not.toContain('Edge 15 New Lantern');
    });
  });

  test('TC-BUG-19-06 v2 PUT with an unknown type id returns 400 and leaves the item unchanged', async ({ request }) => {
    const response = await test.step('PUT item 1 with catalogTypeId 999', () => putV2(request, 1, { ...item1Update, catalogTypeId: 999 }));
    const errors = await errorsOf(response);
    expect(messages(errors, 'CatalogTypeId')).toContain(TYPE_999);
    await test.step('GET item 1 is unchanged', async () => {
      const get = await request.get(`${API}/items/1?${V2}`);
      expect(get.status()).toBe(200);
      const body = await get.json();
      expect(body.catalogTypeId).toBe(1);
      expect(body.catalogBrandId).toBe(1);
      expect(body.name).toBe('Edge 01 Penny Boot');
      expect(body.price).toBe(0.01);
    });
  });

  test('TC-BUG-19-07 v2 PUT with an unknown brand id returns 400', async ({ request }) => {
    const response = await test.step('PUT item 1 with catalogBrandId 999', () => putV2(request, 1, { ...item1Update, catalogBrandId: 999 }));
    expect(messages(await errorsOf(response), 'CatalogBrandId')).toContain(BRAND_999);
  });

  test('TC-BUG-19-08 v1 PUT with an unknown brand id returns 400', async ({ request }) => {
    const response = await test.step('v1 PUT with catalogBrandId 999', () => putV1(request, { ...item1Update, catalogBrandId: 999 }));
    expect(messages(await errorsOf(response), 'CatalogBrandId')).toContain(BRAND_999);
  });

  test('TC-BUG-19-09 create with existing brand and type, including unused ones, still returns 201', async ({ request }) => {
    const response = await test.step('POST create with brand 4 and type 4', () =>
      create(request, { ...newItem, catalogTypeId: 4, catalogBrandId: 4 }));
    expect(response.status()).toBe(201);
    const location = response.headers()['location'];
    expect(location).toMatch(/\/api\/catalog\/items\/\d+$/);
    await test.step('GET the Location URL', async () => {
      const get = await request.get(`${new URL(location, CATALOG_URL)}?${V2}`);
      expect(get.status()).toBe(200);
      const body = await get.json();
      expect(body.catalogTypeId).toBe(4);
      expect(body.catalogBrandId).toBe(4);
    });
  });

  test('TC-BUG-19-10 v2 PUT with existing brand and type still succeeds', async ({ request }) => {
    const response = await test.step('PUT item 2 with type 3 and brand 2', () =>
      putV2(request, 2, { ...item1Update, id: 2, name: 'Edge 02 Trail Boot', pictureFileName: '2.webp', catalogTypeId: 3, catalogBrandId: 2 }));
    expect(response.status()).toBeGreaterThanOrEqual(200);
    expect(response.status()).toBeLessThan(300);
    await test.step('GET item 2 shows the update', async () => {
      const body = await (await request.get(`${API}/items/2?${V2}`)).json();
      expect(body.catalogTypeId).toBe(3);
      expect(body.catalogBrandId).toBe(2);
      expect(body.price).toBe(42.5);
    });
  });

  test('TC-BUG-19-11 v1 PUT with an unknown type id returns 400 naming the id', async ({ request }) => {
    const response = await test.step('v1 PUT with catalogTypeId 999', () => putV1(request, { ...item1Update, catalogTypeId: 999 }));
    expect(messages(await errorsOf(response), 'CatalogTypeId')).toContain(TYPE_999);
  });

  test('TC-BUG-19-12 v2 PUT to a nonexistent item with an unknown brand returns 400, not 404', async ({ request }) => {
    const response = await test.step('PUT item 999999 with catalogBrandId 999', () =>
      putV2(request, 999999, { ...item1Update, id: 999999, name: 'Ghost', price: 10, catalogBrandId: 999 }));
    expect(messages(await errorsOf(response), 'CatalogBrandId')).toContain(BRAND_999);
  });
});
