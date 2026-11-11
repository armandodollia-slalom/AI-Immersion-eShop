import { APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { getTokens } from './auth-basket-helpers';
import { CATALOG_URL } from './ports';

// Catalog.API write endpoints (POST/PUT/DELETE /api/catalog/items) and how the WebApp reflects them.
// Seed data: testing/scenarios/catalog-edge (14 items, ids 1-14; brands and types 1-4). Every test
// writes, so each one reloads the scenario first and does not depend on any other test.
// Flow map: testing/flows/catalog.md.
const API = `${CATALOG_URL}/api/catalog`;

// The write endpoints need an access token of a user in role Admin (the scenario's "admin" user).
const adminTest = test.extend({
  request: async ({ playwright }, use) => {
    const { access_token } = await getTokens('admin', 'Pass123$', 'openid profile catalog');
    const context = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${access_token}` } });
    await use(context);
    await context.dispose();
  },
});

const newItem = {
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

const post = (request: APIRequestContext, data: unknown, version = '1.0') =>
  request.post(`${API}/items?api-version=${version}`, { data });

const getItem = (request: APIRequestContext, id: number) => request.get(`${API}/items/${id}?api-version=1.0`);

async function expectProblem(response: APIResponse, status: number, detail?: string) {
  expect(response.status()).toBe(status);
  // Framework errors use application/problem+json; ProblemDetails returned by the handlers use application/json.
  expect(response.headers()['content-type']).toMatch(/^application\/(problem\+)?json/);
  const body = await response.json();
  expect(body.status).toBe(status);
  if (detail) {
    expect(body.detail).toBe(detail);
  }
  return body;
}

test.describe.configure({ mode: 'default' });

test.describe('Catalog.API admin writes', () => {
  test.beforeEach(() => {
    loadScenario('catalog-edge');
  });

  test.describe('create', () => {
    adminTest('POST creates an item that the API, the catalog page and the product page show', async ({ request, page }) => {
      const response = await post(request, newItem);
      expect(response.status()).toBe(201);
      expect(response.headers()['location']).toBe('/api/catalog/items/15');

      const created = await (await getItem(request, 15)).json();
      expect(created).toMatchObject({ ...newItem, id: 15, onReorder: false, catalogBrand: { id: 2, brand: 'Edge Beta' } });
      expect((await request.get(`${API}/items/15/pic?api-version=1.0`)).status()).toBe(200);

      await page.goto('/?page=2');
      await expect(page.locator('.catalog-count')).toHaveText('15 products');
      await expect(page.locator('.catalog-product .name')).toContainText(['Edge 15 New Lantern']);
      await page.goto('/item/15');
      await expect(page.getByRole('heading', { name: 'Edge 15 New Lantern' })).toBeVisible();
      await expect(page.locator('.add-to-cart .price')).toHaveText('$42.50');
      await expect(page.locator('.item-meta dd')).toHaveText('Edge Beta');
    });

    adminTest('POST works under v2 and honours an explicit id', async ({ request }) => {
      const response = await post(request, { ...newItem, id: 500 }, '2.0');
      expect(response.status()).toBe(201);
      expect(response.headers()['location']).toBe('/api/catalog/items/500');
      expect((await (await getItem(request, 500)).json()).name).toBe(newItem.name);
    });

    adminTest('malformed, empty, wrongly typed and non-object bodies are 400', async ({ request }) => {
      const send = (data: string) =>
        request.post(`${API}/items?api-version=1.0`, { data, headers: { 'Content-Type': 'application/json' } });
      await expectProblem(await send('{not json'), 400);
      await expectProblem(await send(''), 400);
      await expectProblem(await send('[]'), 400);
      await expectProblem(await send(JSON.stringify({ ...newItem, price: 'cheap' })), 400);
      await expectProblem(await send(JSON.stringify({ ...newItem, catalogTypeId: 'boots' })), 400);
      expect((await request.get(`${API}/items?api-version=1.0`).then(r => r.json())).count).toBe(14);
    });

    adminTest('a non-JSON content type is 415', async ({ request }) => {
      const response = await request.post(`${API}/items?api-version=1.0`, {
        data: JSON.stringify(newItem),
        headers: { 'Content-Type': 'text/plain' },
      });
      expect(response.status()).toBe(415);
    });

    adminTest('a missing or unsupported API version is 400', async ({ request }) => {
      await expectProblem(await request.post(`${API}/items`, { data: newItem }), 400, 'An API version is required, but was not specified.');
      expect((await post(request, newItem, '3.0')).status()).toBe(400);
    });

    adminTest('a body without a name is rejected with 400', async ({ request }) => {
      const { name: _name, ...withoutName } = newItem;
      await expectProblem(await post(request, withoutName), 400);
    });

    // BUG: there is no validation on create; an empty name and a negative price are stored (201).
    adminTest.fixme('an empty name or a negative price is rejected with 400', async ({ request }) => {
      await expectProblem(await post(request, { ...newItem, name: '' }), 400);
      await expectProblem(await post(request, { ...newItem, price: -5 }), 400);
    });

    // BUG-18: an id that already exists is rejected with 409 instead of a primary-key violation.
    adminTest('creating an item with an existing id is rejected with 409', async ({ request }) => {
      expect((await post(request, { ...newItem, id: 1 })).status()).toBe(409);
      expect((await (await getItem(request, 1)).json()).name).toBe('Edge 01 Penny Boot');
    });

    adminTest('TC-BUG-19-13 unknown brand or type ids are rejected with 400', async ({ request }) => {
      await expectProblem(await post(request, { ...newItem, catalogTypeId: 999 }), 400);
      await expectProblem(await post(request, { ...newItem, catalogBrandId: 999 }), 400);
    });

    // Anonymous callers (no Authorization header) are rejected on every write.
    test('TC-BUG-4-12 anonymous callers cannot create, update or delete items', async ({ request }) => {
      expect((await post(request, newItem)).status()).toBe(401);
      expect((await request.put(`${API}/items/1?api-version=2.0`, { data: { ...newItem, id: 1 } })).status()).toBe(401);
      expect((await request.delete(`${API}/items/1?api-version=1.0`)).status()).toBe(401);
    });
  });

  test.describe('update', () => {
    adminTest('v2 PUT /items/{id} replaces the item and the product page shows the new price', async ({ request, page }) => {
      const replacement = { ...newItem, id: 3, name: 'Edge 03 Summit Boot', price: 1500, catalogTypeId: 1, catalogBrandId: 1, pictureFileName: '3.webp' };
      const response = await request.put(`${API}/items/3?api-version=2.0`, { data: replacement });
      expect(response.status()).toBe(201);
      expect(response.headers()['location']).toBe('/api/catalog/items/3');
      expect(await (await getItem(request, 3)).json()).toMatchObject({ ...replacement, catalogBrand: { brand: 'Edge Alpha' } });

      await page.goto('/item/3');
      await expect(page.locator('.add-to-cart .price')).toHaveText('$1,500.00');
      await expect(page.locator('.item-desc')).toHaveText(newItem.description);
    });

    adminTest('v1 PUT /items takes the id from the body and replaces every field', async ({ request }) => {
      const response = await request.put(`${API}/items?api-version=1.0`, {
        data: { id: 2, name: 'Edge 02 Trail Boot v2', price: 59.5, catalogTypeId: 1, catalogBrandId: 1 },
      });
      expect(response.status()).toBe(201);
      // "Create or replace": fields left out of the body are reset to their defaults, not kept.
      expect(await (await getItem(request, 2)).json()).toMatchObject({
        id: 2,
        name: 'Edge 02 Trail Boot v2',
        price: 59.5,
        description: null,
        pictureFileName: null,
        availableStock: 0,
        maxStockThreshold: 0,
      });
      expect((await request.get(`${API}/items/2/pic?api-version=1.0`)).status()).toBe(404);
    });

    adminTest('updating an unknown id is 404 with a detail message', async ({ request }) => {
      await expectProblem(
        await request.put(`${API}/items/99999?api-version=2.0`, { data: { ...newItem, id: 99999 } }),
        404,
        'Item with id 99999 not found.',
      );
      await expectProblem(
        await request.put(`${API}/items?api-version=1.0`, { data: { ...newItem, id: 99999 } }),
        404,
        'Item with id 99999 not found.',
      );
    });

    adminTest('each PUT route only exists in its own version', async ({ request }) => {
      const body = { ...newItem, id: 4 };
      expect((await request.put(`${API}/items?api-version=2.0`, { data: body })).status()).toBe(400);
      expect((await request.put(`${API}/items/4?api-version=1.0`, { data: body })).status()).toBe(400);
      expect((await (await getItem(request, 4)).json()).name).toBe('Edge 04 Day Pack');
    });

    adminTest('a malformed body or a non-integer id is rejected without changes', async ({ request }) => {
      const malformed = await request.put(`${API}/items/7?api-version=2.0`, {
        data: '{not json',
        headers: { 'Content-Type': 'application/json' },
      });
      await expectProblem(malformed, 400);
      expect((await request.put(`${API}/items/abc?api-version=2.0`, { data: newItem })).status()).toBe(404);
      expect((await (await getItem(request, 7)).json()).name).toBe('Edge 07 Dome Tent');
    });

    adminTest('v1 PUT without an id in the body is 400', async ({ request }) => {
      await expectProblem(
        await request.put(`${API}/items?api-version=1.0`, { data: newItem }),
        400,
        'Item id must be provided in the request body.',
      );
    });

    adminTest('v2 PUT with a body id different from the route id is 400', async ({ request }) => {
      await expectProblem(await request.put(`${API}/items/4?api-version=2.0`, { data: { ...newItem, id: 5 } }), 400);
    });

    adminTest('v2 PUT with an unknown type id is 400', async ({ request }) => {
      await expectProblem(await request.put(`${API}/items/7?api-version=2.0`, { data: { ...newItem, id: 7, catalogTypeId: 999 } }), 400);
    });
  });

  test.describe('delete', () => {
    adminTest('DELETE removes the item from the API and the WebApp; a second delete is 404', async ({ request, page }) => {
      const response = await request.delete(`${API}/items/14?api-version=1.0`);
      expect(response.status()).toBe(204);
      expect(await response.text()).toBe('');

      await expectProblem(await getItem(request, 14), 404);
      expect((await request.get(`${API}/items?api-version=1.0`).then(r => r.json())).count).toBe(13);
      await expectProblem(await request.delete(`${API}/items/14?api-version=2.0`), 404);

      const notFound = await page.goto('/item/14');
      expect(notFound?.status()).toBe(404);
      await page.goto('/?page=2');
      await expect(page.locator('.catalog-count')).toHaveText('13 products');
      await expect(page.locator('.catalog-product .name')).not.toContainText(['Edge 14 Last Item']);
    });

    adminTest('deleting unknown, zero or non-integer ids is 404 and changes nothing', async ({ request }) => {
      for (const id of ['99999', '0', '-1', 'abc']) {
        expect((await request.delete(`${API}/items/${id}?api-version=1.0`)).status(), id).toBe(404);
      }
      expect((await request.get(`${API}/items?api-version=1.0`).then(r => r.json())).count).toBe(14);
    });

    adminTest('DELETE without an API version is 400 and keeps the item', async ({ request }) => {
      await expectProblem(await request.delete(`${API}/items/13`), 400, 'An API version is required, but was not specified.');
      expect((await getItem(request, 13)).status()).toBe(200);
    });
  });
});
