import { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { getTokens } from './auth-basket-helpers';
import { CATALOG_URL } from './ports';

// BUG-17: POST /api/catalog/items without a name must be a 400 validation problem, not a 500.
// Plan: tests/plans/BUG-17-catalog-create-without-name-500. Scenario: testing/scenarios/bug-17.
const API = `${CATALOG_URL}/api/catalog`;
const V2 = 'api-version=2.0';

const NO_NAME_BODY = {
  description: 'No name',
  price: 10,
  pictureFileName: '1.webp',
  catalogTypeId: 1,
  catalogBrandId: 1,
  availableStock: 5,
  restockThreshold: 1,
  maxStockThreshold: 10,
};

const count = async (request: APIRequestContext) => {
  const response = await request.get(`${API}/items?${V2}&pageIndex=0&pageSize=1`);
  expect(response.status()).toBe(200);
  return (await response.json()).count as number;
};

test.describe.configure({ mode: 'default' });

test.describe('BUG-17 catalog create without a name', () => {
  let auth: { Authorization: string };

  test.beforeEach(async () => {
    loadScenario('bug-17');
    const { access_token } = await getTokens('admin', 'Pass123$', 'openid profile catalog');
    auth = { Authorization: `Bearer ${access_token}` };
  });

  const createWithoutName = (request: APIRequestContext) =>
    request.post(`${API}/items?${V2}`, { data: NO_NAME_BODY, headers: auth });

  test('TC-BUG-17-01 create without name returns 400 validation problem', async ({ request }) => {
    const response = await test.step('POST create as admin with no name property', () => createWithoutName(request));
    expect(response.status()).toBe(400);
    expect(response.headers()['content-type']).toContain('application/problem+json');
    const body = await response.json();
    expect(typeof body.errors).toBe('object');
    expect(body.errors).not.toBeNull();
  });

  test('TC-BUG-17-02 validation problem identifies the missing name field', async ({ request }) => {
    const response = await test.step('POST create as admin with no name property', () => createWithoutName(request));
    expect(response.status()).toBe(400);
    const errors = (await response.json()).errors as Record<string, string[]>;
    const keys = Object.keys(errors);
    expect(keys).toHaveLength(1);
    expect(keys[0].toLowerCase()).toBe('name');
    expect(Array.isArray(errors[keys[0]])).toBe(true);
    expect(errors[keys[0]].length).toBeGreaterThan(0);
    for (const message of errors[keys[0]]) expect(message.length).toBeGreaterThan(0);
  });

  test('TC-BUG-17-03 rejected create without name stores no item', async ({ request }) => {
    const before = await test.step('note the item count', () => count(request));
    const response = await test.step('POST create as admin with no name property', () => createWithoutName(request));
    expect(response.status()).toBe(400);
    await test.step('item count is unchanged', async () => {
      expect(await count(request)).toBe(before);
    });
  });

  test('TC-BUG-17-04 create with a name still returns 201', async ({ request }) => {
    const response = await test.step('POST create as admin with a name', () =>
      request.post(`${API}/items?${V2}`, { data: { ...NO_NAME_BODY, name: 'BUG-17 Valid Item', description: 'Has name' }, headers: auth }));
    expect(response.status()).toBe(201);
    const location = response.headers()['location'];
    expect(location).toBeTruthy();
    const get = await test.step('GET the Location URL (with the api-version the API requires)', () => request.get(`${new URL(location, CATALOG_URL)}?${V2}`));
    expect(get.status()).toBe(200);
    expect((await get.json()).name).toBe('BUG-17 Valid Item');
  });
});
