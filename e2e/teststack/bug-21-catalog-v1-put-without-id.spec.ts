import { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { getTokens } from './auth-basket-helpers';
import { CATALOG_URL } from './ports';

// BUG-21: PUT /api/catalog/items?api-version=1.0 without a usable body id must be a 400, not a 404.
// Plan: tests/plans/BUG-21-catalog-v1-put-without-id-404. Scenario: testing/scenarios/bug-21.
const API = `${CATALOG_URL}/api/catalog`;
const V1 = 'api-version=1.0';
const ID_REQUIRED = 'Item id must be provided in the request body.';

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
const SHORT = { name: 'Edge 15 New Lantern', price: 42.5, catalogTypeId: 3, catalogBrandId: 2 };

test.describe.configure({ mode: 'default' });

test.describe('BUG-21 catalog v1 PUT without a body id', () => {
  let auth: { Authorization: string };

  test.beforeEach(async () => {
    loadScenario('bug-21');
    const { access_token } = await getTokens('admin', 'Pass123$', 'openid profile catalog');
    auth = { Authorization: `Bearer ${access_token}` };
  });

  const put = (request: APIRequestContext, data: object) =>
    request.put(`${API}/items?${V1}`, { data, headers: auth });

  const expectIdRequired = async (response: Awaited<ReturnType<typeof put>>) => {
    expect(response.status()).toBe(400);
    // Handlers returning TypedResults.BadRequest<ProblemDetails> serialize as application/json (see catalog-admin.spec.ts expectProblem).
    expect(response.headers()['content-type']).toMatch(/^application\/(problem\+)?json/);
    const problem = await response.json();
    expect(problem.status).toBe(400);
    expect(problem.detail).toBe(ID_REQUIRED);
    return problem;
  };

  test('TC-BUG-21-01 v1 PUT with no id in the body returns 400 with the id-required message', async ({ request }) => {
    const response = await test.step('PUT items with no "id" property', () => put(request, BODY));
    const problem = await expectIdRequired(response);
    expect(JSON.stringify(problem)).not.toContain('Item with id 0 not found.');
  });

  test('TC-BUG-21-02 v1 PUT with an explicit id of 0 returns 400 with the id-required message', async ({ request }) => {
    const response = await test.step('PUT items with "id": 0', () => put(request, { id: 0, ...SHORT }));
    await expectIdRequired(response);
  });

  test('TC-BUG-21-03 v1 PUT with a negative id returns 400 with the id-required message', async ({ request }) => {
    const response = await test.step('PUT items with "id": -1', () => put(request, { id: -1, ...SHORT }));
    await expectIdRequired(response);
  });

  test('TC-BUG-21-04 rejected v1 PUT without an id leaves the catalog unchanged', async ({ request }) => {
    const response = await test.step('PUT items with no "id" property', () => put(request, BODY));
    expect(response.status()).toBe(400);

    await test.step('GET items still returns 14 items', async () => {
      const list = await request.get(`${API}/items?${V1}`);
      expect(list.status()).toBe(200);
      expect((await list.json()).count).toBe(14);
    });

    await test.step('GET item 1 is unchanged', async () => {
      const response = await request.get(`${API}/items/1?${V1}`);
      expect(response.status()).toBe(200);
      const item = await response.json();
      expect(item.id).toBe(1);
      expect(item.name).toBe('Edge 01 Penny Boot');
      expect(item.price).toBe(0.01);
    });
  });

  test('TC-BUG-21-05 v1 PUT with a valid body id still updates the item', async ({ request }) => {
    const response = await test.step('PUT items with "id": 1', () =>
      put(request, { id: 1, name: 'Edge 01 Penny Boot v2', price: 0.02, catalogTypeId: 1, catalogBrandId: 1 }));
    expect(response.status()).toBe(201);

    await test.step('GET item 1 has the new values', async () => {
      const response = await request.get(`${API}/items/1?${V1}`);
      expect(response.status()).toBe(200);
      const item = await response.json();
      expect(item.id).toBe(1);
      expect(item.name).toBe('Edge 01 Penny Boot v2');
      expect(item.price).toBe(0.02);
    });
  });

  test('TC-BUG-21-06 v1 PUT with an unknown positive id still returns 404', async ({ request }) => {
    const response = await test.step('PUT items with "id": 99999', () => put(request, { id: 99999, ...SHORT }));
    expect(response.status()).toBe(404);
    expect((await response.json()).detail).toBe('Item with id 99999 not found.');
  });
});
