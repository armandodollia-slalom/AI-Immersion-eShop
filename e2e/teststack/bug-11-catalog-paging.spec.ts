import fs from 'fs';
import path from 'path';
import { APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { CATALOG_URL, MOBILE_BFF_URL } from './ports';

// BUG-11: out-of-range paging values (pageSize outside 0..100, pageIndex < 0) are a 400 validation problem, not a 500.
// Plan: tests/plans/BUG-11-catalog-negative-paging-500. Scenario: testing/scenarios/bug-11 (17 items).
const API = `${CATALOG_URL}/api/catalog`;
const BFF = `${MOBILE_BFF_URL}/catalog-api/api/catalog`;
const V1 = 'api-version=1.0';
const V2 = 'api-version=2.0';
const TOTAL = 17;
const root = path.join(__dirname, '..', '..');

type Page = { pageIndex: number; pageSize: number; count: number; data: { id: number }[] };

/** 400 problem+json with an errors entry for each given field (case-insensitive). */
async function expectValidationProblem(response: APIResponse, fields: string[], any = false) {
  expect(response.status(), await response.text()).toBe(400);
  expect(response.headers()['content-type']).toContain('application/problem+json');
  const body = await response.json();
  expect(body.status).toBe(400);
  expect(typeof body.errors).toBe('object');
  const keys = Object.keys(body.errors).map(k => k.toLowerCase());
  expect(keys.length).toBeGreaterThan(0);
  const present = fields.map(f => keys.includes(f.toLowerCase()));
  expect(any ? present.some(Boolean) : present.every(Boolean), `errors keys: ${keys}`).toBe(true);
  expect(body.items).toBeUndefined();
  expect(body.data).toBeUndefined();
}

async function getPage(request: APIRequestContext, query: string): Promise<Page> {
  const response = await request.get(`${API}/items?${query}`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

test.describe.configure({ mode: 'default' });

test.describe('BUG-11 catalog paging validation', () => {
  test.beforeAll(() => {
    loadScenario('bug-11');
  });

  test('TC-BUG-11-01 GET v2 items with pageSize=-1 is 400 validation problem', async ({ request }) => {
    await test.step('GET v2 items?pageSize=-1', async () => {
      await expectValidationProblem(await request.get(`${API}/items?${V2}&pageSize=-1`), ['pageSize']);
    });
  });

  test('TC-BUG-11-02 GET v2 items with pageIndex=-1 is 400 validation problem', async ({ request }) => {
    await test.step('GET v2 items?pageIndex=-1', async () => {
      await expectValidationProblem(await request.get(`${API}/items?${V2}&pageIndex=-1`), ['pageIndex']);
    });
  });

  test('TC-BUG-11-03 GET v1 items with pageSize=-1 is 400 validation problem', async ({ request }) => {
    await test.step('GET v1 items?pageSize=-1', async () => {
      await expectValidationProblem(await request.get(`${API}/items?${V1}&pageSize=-1`), ['pageSize']);
    });
  });

  test('TC-BUG-11-04 GET v1 items with pageIndex=-1 is 400 validation problem', async ({ request }) => {
    await test.step('GET v1 items?pageIndex=-1', async () => {
      await expectValidationProblem(await request.get(`${API}/items?${V1}&pageIndex=-1`), ['pageIndex']);
    });
  });

  test('TC-BUG-11-05 Mobile BFF route with pageSize=-1 is 400 validation problem', async ({ request }) => {
    await test.step('GET BFF items?pageSize=-1', async () => {
      const response = await request.get(`${BFF}/items?${V2}&pageSize=-1`);
      expect([500, 502]).not.toContain(response.status());
      await expectValidationProblem(response, ['pageSize']);
    });
  });

  test('TC-BUG-11-06 Mobile BFF route with pageIndex=-1 is 400 validation problem', async ({ request }) => {
    await test.step('GET BFF items?pageIndex=-1', async () => {
      const response = await request.get(`${BFF}/items?${V2}&pageIndex=-1`);
      expect([500, 502]).not.toContain(response.status());
      await expectValidationProblem(response, ['pageIndex']);
    });
  });

  test('TC-BUG-11-07 pageSize=101 is rejected with 400', async ({ request }) => {
    await test.step('GET v2 items?pageSize=101', async () => {
      await expectValidationProblem(await request.get(`${API}/items?${V2}&pageSize=101`), ['pageSize']);
    });
  });

  test('TC-BUG-11-08 pageSize=100 is accepted', async ({ request }) => {
    await test.step('GET v2 items?pageSize=100', async () => {
      const page = await getPage(request, `${V2}&pageSize=100`);
      expect(page.pageSize).toBe(100);
      expect(page.pageIndex).toBe(0);
      expect(page.count).toBe(TOTAL);
      expect(page.data).toHaveLength(Math.min(page.count, 100));
    });
  });

  test('TC-BUG-11-09 pageSize=0 stays accepted and returns an empty page', async ({ request }) => {
    await test.step('GET v1 items?pageSize=0', async () => {
      const page = await getPage(request, `${V1}&pageSize=0`);
      expect(page.pageIndex).toBe(0);
      expect(page.pageSize).toBe(0);
      expect(page.count).toBe(TOTAL);
      expect(page.data).toEqual([]);
    });
  });

  test('TC-BUG-11-10 pageIndex=0 is accepted and returns the first page', async ({ request }) => {
    await test.step('GET v2 items?pageIndex=0&pageSize=5', async () => {
      const page = await getPage(request, `${V2}&pageIndex=0&pageSize=5`);
      const defaultPage = await getPage(request, `${V2}&pageSize=5`);
      expect(page.pageIndex).toBe(0);
      expect(page.pageSize).toBe(5);
      expect(page.data).toHaveLength(5);
      expect(page.data.map(i => i.id)).toEqual(defaultPage.data.map(i => i.id));
    });
  });

  test('TC-BUG-11-11 Page index past the end still returns 200 with an empty page', async ({ request }) => {
    await test.step('GET v1 items?pageIndex=100', async () => {
      const page = await getPage(request, `${V1}&pageIndex=100`);
      expect(page.pageIndex).toBe(100);
      expect(page.pageSize).toBe(10);
      expect(page.count).toBe(TOTAL);
      expect(page.data).toEqual([]);
    });
  });

  test('TC-BUG-11-12 Negative pageSize and pageIndex together are rejected with 400', async ({ request }) => {
    await test.step('GET v2 items?pageSize=-1&pageIndex=-1', async () => {
      await expectValidationProblem(await request.get(`${API}/items?${V2}&pageSize=-1&pageIndex=-1`), ['pageSize', 'pageIndex'], true);
    });
  });

  const bothParams = (route: string, version = V1) => async ({ request }: { request: APIRequestContext }) => {
    const sep = route.includes('?') ? '&' : '?';
    await test.step('negative pageSize', async () => {
      await expectValidationProblem(await request.get(`${API}${route}${sep}${version}&pageSize=-1`), ['pageSize']);
    });
    await test.step('negative pageIndex', async () => {
      await expectValidationProblem(await request.get(`${API}${route}${sep}${version}&pageIndex=-1`), ['pageIndex']);
    });
  };

  test('TC-BUG-11-13 GET items by name with negative paging is 400', bothParams('/items/by/Edge'));
  test('TC-BUG-11-14 GET items by type and brand with negative paging is 400', bothParams('/items/type/1/brand/1'));
  test('TC-BUG-11-15 GET items by brand with negative paging is 400', bothParams('/items/type/all/brand/1'));

  test('TC-BUG-11-16 catalog-api.spec passes with the fixme marker removed', async () => {
    await test.step('the fixme marker is gone and the test is a normal test', () => {
      const spec = fs.readFileSync(path.join(__dirname, 'catalog-api.spec.ts'), 'utf8');
      expect(spec).not.toMatch(/test\.fixme\(\s*'negative pageSize or pageIndex is rejected with 400'/);
      expect(spec).toMatch(/\btest\(\s*'negative pageSize or pageIndex is rejected with 400'/);
    });
  });

  test('TC-BUG-11-17 Bug row removed from the bugs table in testing/flows/catalog.md', async () => {
    await test.step('no bugs-table row about negative paging returning 500', () => {
      const flows = fs.readFileSync(path.join(root, 'testing', 'flows', 'catalog.md'), 'utf8').split('\n');
      const bugRows = flows.filter(l => l.startsWith('|') && /negative/i.test(l) && /page(Size|Index)/i.test(l) && /500/.test(l));
      expect(bugRows).toEqual([]);
      const mentions = flows.filter(l => /negative/i.test(l) && /page(Size|Index)/i.test(l));
      expect(mentions.length).toBeGreaterThan(0);
      for (const line of mentions) {
        expect(line).toContain('400');
      }
    });
  });

  test('TC-BUG-11-18 GET relevant items v1 with negative paging is 400', bothParams('/items/withsemanticrelevance/Edge'));

  test('TC-BUG-11-19 GET relevant items v2 with negative paging is 400', bothParams('/items/withsemanticrelevance?text=Edge', V2));
});
