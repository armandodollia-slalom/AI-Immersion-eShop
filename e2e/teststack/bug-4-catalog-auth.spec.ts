import fs from 'fs';
import path from 'path';
import { APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { getTokens } from './auth-basket-helpers';
import { CATALOG_URL } from './ports';

// BUG-4: Catalog.API create, update and delete need a bearer token of a user in role Admin; reads stay anonymous.
// Plan: tests/plans/BUG-4-catalog-write-endpoints-unauthenticated. Scenario: testing/scenarios/bug-4.
const API = `${CATALOG_URL}/api/catalog`;
const V2 = 'api-version=2.0';
const V1 = 'api-version=1.0';

const newItem = (name: string) => ({
  name,
  description: 'Created by the BUG-4 test.',
  price: 10,
  pictureFileName: '7.webp',
  catalogTypeId: 3,
  catalogBrandId: 2,
  availableStock: 12,
  restockThreshold: 2,
  maxStockThreshold: 50,
});

const item1Body = (price: number) => ({ ...newItem('Edge 01 Penny Boot'), id: 1, price, catalogTypeId: 1, catalogBrandId: 1, pictureFileName: '1.webp' });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const list = async (request: APIRequestContext) => {
  const response = await request.get(`${API}/items?${V2}&pageIndex=0&pageSize=100`);
  expect(response.status()).toBe(200);
  return response.json();
};
const getItem = (request: APIRequestContext, id: number) => request.get(`${API}/items/${id}?${V2}`);
const statusOf = (response: APIResponse) => response.status();

test.describe.configure({ mode: 'default' });

test.describe('BUG-4 catalog write authorization', () => {
  test.beforeEach(() => {
    loadScenario('bug-4');
  });

  test('TC-BUG-4-01 anonymous POST create item is 401', async ({ request }) => {
    const before = await test.step('note the item count', () => list(request));
    const response = await test.step('POST create without Authorization', () =>
      request.post(`${API}/items?${V2}`, { data: newItem('Anon item') }));
    expect(response.status()).toBe(401);
    await test.step('nothing was created', async () => {
      const after = await list(request);
      expect(after.count).toBe(before.count);
      expect(after.data.map((i: { name: string }) => i.name)).not.toContain('Anon item');
    });
  });

  test('TC-BUG-4-02 anonymous PUT v2 update item is 401', async ({ request }) => {
    const before = (await (await getItem(request, 1)).json()).price;
    const response = await test.step('PUT v2 without Authorization', () =>
      request.put(`${API}/items/1?${V2}`, { data: item1Body(999.99) }));
    expect(response.status()).toBe(401);
    await test.step('price is unchanged', async () => {
      expect((await (await getItem(request, 1)).json()).price).toBe(before);
    });
  });

  test('TC-BUG-4-03 anonymous PUT v1 update item is 401', async ({ request }) => {
    const before = (await (await getItem(request, 1)).json()).price;
    const response = await test.step('PUT v1 without Authorization', () =>
      request.put(`${API}/items?${V1}`, { data: item1Body(999.99) }));
    expect(response.status()).toBe(401);
    await test.step('price is unchanged', async () => {
      expect((await (await getItem(request, 1)).json()).price).toBe(before);
    });
  });

  test('TC-BUG-4-04 anonymous DELETE item is 401', async ({ request }) => {
    const response = await test.step('DELETE without Authorization', () => request.delete(`${API}/items/1?${V2}`));
    expect(response.status()).toBe(401);
    await test.step('item 1 still exists', async () => {
      expect((await getItem(request, 1)).status()).toBe(200);
    });
  });

  test('TC-BUG-4-05 rejected anonymous writes leave the catalog unchanged', async ({ request }) => {
    const listBefore = await test.step('snapshot list and item 1', () => list(request));
    const itemBefore = await (await getItem(request, 1)).json();

    const statuses = await test.step('anonymous POST, PUT and DELETE', async () => [
      statusOf(await request.post(`${API}/items?${V2}`, { data: newItem('Anon item') })),
      statusOf(await request.put(`${API}/items/1?${V2}`, { data: item1Body(999.99) })),
      statusOf(await request.delete(`${API}/items/1?${V2}`)),
    ]);
    expect(statuses).toEqual([401, 401, 401]);

    await test.step('snapshots are identical', async () => {
      expect(await list(request)).toEqual(listBefore);
      expect(await (await getItem(request, 1)).json()).toEqual(itemBefore);
    });
  });

  test('TC-BUG-4-06 invalid bearer token on write is 401', async ({ request }) => {
    const response = await test.step('DELETE with a bogus bearer token', () =>
      request.delete(`${API}/items/1?${V2}`, { headers: bearer('not-a-real-token') }));
    expect(response.status()).toBe(401);
    await test.step('item 1 still exists', async () => {
      expect((await getItem(request, 1)).status()).toBe(200);
    });
  });

  test('TC-BUG-4-07 authenticated non-admin user gets 403 on write', async ({ request }) => {
    const { access_token } = await test.step('alice signs in with scope catalog', () =>
      getTokens('alice', 'Pass123$', 'openid profile catalog'));
    const headers = bearer(access_token);
    const price = (await (await getItem(request, 1)).json()).price;
    const countBefore = (await list(request)).count;

    const statuses = await test.step('alice PUT, POST and DELETE', async () => [
      statusOf(await request.put(`${API}/items/1?${V2}`, { headers, data: item1Body(999.99) })),
      statusOf(await request.post(`${API}/items?${V2}`, { headers, data: newItem('Alice item') })),
      statusOf(await request.delete(`${API}/items/1?${V2}`, { headers })),
    ]);
    expect(statuses).toEqual([403, 403, 403]);

    await test.step('catalog is unchanged', async () => {
      expect((await (await getItem(request, 1)).json()).price).toBe(price);
      expect((await list(request)).count).toBe(countBefore);
    });
  });

  test.describe('as admin', () => {
    let headers: Record<string, string>;

    test.beforeEach(async () => {
      const { access_token } = await getTokens('admin', 'Pass123$', 'openid profile catalog');
      headers = bearer(access_token);
    });

    test('TC-BUG-4-08 admin can create an item', async ({ request }) => {
      const response = await test.step('POST create as admin', () =>
        request.post(`${API}/items?${V2}`, { headers, data: newItem('Admin item') }));
      expect(response.status()).toBe(201);
      await test.step('anonymous list shows the item', async () => {
        expect((await list(request)).data.map((i: { name: string }) => i.name)).toContain('Admin item');
      });
    });

    test('TC-BUG-4-09 admin can update an item and the change persists', async ({ request }) => {
      const response = await test.step('PUT v2 as admin', () =>
        request.put(`${API}/items/1?${V2}`, { headers, data: item1Body(999.99) }));
      expect(response.status()).toBe(201);
      await test.step('anonymous GET shows the new price', async () => {
        expect((await (await getItem(request, 1)).json()).price).toBe(999.99);
      });
    });

    test('TC-BUG-4-10 admin can delete an item', async ({ request }) => {
      const created = await test.step('admin creates an item', () =>
        request.post(`${API}/items?${V2}`, { headers, data: newItem('Admin item to delete') }));
      expect(created.status()).toBe(201);
      const id = Number(created.headers()['location'].split('/').pop());

      const response = await test.step('DELETE as admin', () => request.delete(`${API}/items/${id}?${V2}`, { headers }));
      expect(response.status()).toBe(204);
      await test.step('anonymous GET is 404', async () => {
        expect((await getItem(request, id)).status()).toBe(404);
      });
    });

    test('TC-BUG-4-13 admin can update an item through the v1 route', async ({ request }) => {
      const response = await test.step('PUT v1 as admin', () =>
        request.put(`${API}/items?${V1}`, { headers, data: item1Body(888.88) }));
      expect(response.status()).toBe(201);
      await test.step('anonymous GET shows the new price', async () => {
        expect((await (await getItem(request, 1)).json()).price).toBe(888.88);
      });
    });
  });

  test('TC-BUG-4-11 catalog reads stay anonymous', async ({ request }) => {
    const items = await test.step('GET the item list without Authorization', () =>
      request.get(`${API}/items?${V2}&pageIndex=0&pageSize=10`));
    expect(items.status()).toBe(200);
    expect((await items.json()).data.length).toBeGreaterThan(0);

    const one = await test.step('GET item 1 without Authorization', () => getItem(request, 1));
    expect(one.status()).toBe(200);
    expect((await one.json()).id).toBe(1);
  });
});

// TC-BUG-4-12 is the "anonymous callers cannot create, update or delete items" test in catalog-admin.spec.ts.

test('TC-BUG-4-14 bug row is removed from the bugs table in testing/flows', async () => {
  const dir = path.join(__dirname, '..', '..', 'testing', 'flows');
  await test.step('catalog.md still exists', async () => {
    expect(fs.existsSync(path.join(dir, 'catalog.md'))).toBe(true);
  });
  await test.step('no bugs-table row describes unauthenticated catalog writes', async () => {
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
      const rows = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(l => l.startsWith('|'));
      for (const row of rows) {
        expect(row, `${file}: ${row}`).not.toMatch(/need no authentication|anonymous callers cannot create, update or delete/i);
      }
    }
  });
});
