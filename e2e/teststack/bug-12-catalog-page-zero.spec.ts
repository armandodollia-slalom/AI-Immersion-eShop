import fs from 'fs';
import path from 'path';
import { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { WEBAPP_URL } from './ports';

// BUG-12: ?page=0 and negative pages are treated as the first catalog page.
// Plan: tests/plans/BUG-12-webapp-page-zero-broken. Scenario: testing/scenarios/bug-12 (14 Edge items, 9 per page).
const root = path.join(__dirname, '..', '..');
const LONG_NAME = 'Edge 13 Ultra Long Name Hiking Pack Edition Max 50';

const names = (page: Page) => page.locator('.catalog-product .name');
const pager = (page: Page) => page.getByRole('navigation', { name: 'Catalog pages' });
const errorBar = (page: Page) => page.getByText('An unhandled error has occurred.');

async function expectFirstPage(page: Page) {
  await expect(page.locator('.catalog-count')).toHaveText('14 products');
  await expect(page.locator('.catalog-product')).toHaveCount(9);
  await expect(names(page).first()).toHaveText('Edge 01 Penny Boot');
  await expect(errorBar(page)).toHaveCount(0);
}

test.describe.configure({ mode: 'default' });

test.describe('BUG-12 catalog page zero', () => {
  test.beforeAll(() => {
    loadScenario('bug-12');
  });

  test('TC-BUG-12-01 ?page=0 shows the first catalog page', async ({ page }) => {
    await test.step('open /?page=0', async () => {
      await page.goto(`${WEBAPP_URL}/?page=0`);
      await expectFirstPage(page);
    });
  });

  test('TC-BUG-12-02 ?page=-1 shows the first catalog page', async ({ page }) => {
    await test.step('open /?page=-1', async () => {
      await page.goto(`${WEBAPP_URL}/?page=-1`);
      await expectFirstPage(page);
    });
  });

  test('TC-BUG-12-03 ?page=0 pager shows 1 / 2 with Prev disabled', async ({ page }) => {
    await test.step('open /?page=0', async () => {
      await page.goto(`${WEBAPP_URL}/?page=0`);
    });
    await test.step('locate the Catalog pages navigation', async () => {
      const nav = pager(page);
      await expect(nav.locator('.page-status')).toHaveText('1 / 2');
      await expect(nav.locator('.page-number')).toHaveText(['1', '2']);
      await expect(nav.locator('.page-number.active-page')).toHaveText('1');
      await expect(nav.locator('span.page-nav.is-disabled')).toHaveCount(1);
      await expect(nav.locator('span.page-nav.is-disabled')).toHaveText(/Prev/);
      await expect(nav.getByRole('link', { name: 'Previous page' })).toHaveCount(0);
      await expect(nav.getByRole('link', { name: 'Next page' })).toBeVisible();
    });
  });

  test('TC-BUG-12-04 ?page=-1 pager shows 1 / 2 with Prev disabled', async ({ page }) => {
    await test.step('open /?page=-1', async () => {
      await page.goto(`${WEBAPP_URL}/?page=-1`);
    });
    await test.step('locate the Catalog pages navigation', async () => {
      const nav = pager(page);
      await expect(nav.locator('.page-status')).toHaveText('1 / 2');
      await expect(nav.locator('.page-number.active-page')).toHaveText('1');
      await expect(nav.getByRole('link', { name: 'Previous page' })).toHaveCount(0);
      await expect(nav.locator('span.page-nav.is-disabled')).toHaveText(/Prev/);
    });
  });

  test('TC-BUG-12-05 Next from ?page=0 goes to page 2', async ({ page }) => {
    await test.step('open /?page=0', async () => {
      await page.goto(`${WEBAPP_URL}/?page=0`);
      await expect(page.locator('.catalog-product')).toHaveCount(9);
    });
    await test.step('click Next page', async () => {
      await pager(page).getByRole('link', { name: 'Next page' }).click();
      await expect(page).toHaveURL(/\?page=2$/);
      await expect(page.locator('.catalog-product')).toHaveCount(5);
      await expect(names(page)).toHaveText([
        'Edge 10 Bivy',
        'Edge 11 Hiking Boot',
        'Edge 12 Mega Pack',
        LONG_NAME,
        'Edge 14 Last Item',
      ]);
      await expect(pager(page).locator('.page-status')).toHaveText('2 / 2');
    });
  });

  test('TC-BUG-12-06 ?page=1 still shows the first page', async ({ page }) => {
    await test.step('open /?page=1', async () => {
      await page.goto(`${WEBAPP_URL}/?page=1`);
      await expectFirstPage(page);
      await expect(pager(page).locator('.page-status')).toHaveText('1 / 2');
    });
  });

  test('TC-BUG-12-07 ?page=2 still shows the second page', async ({ page }) => {
    await test.step('open /?page=2', async () => {
      await page.goto(`${WEBAPP_URL}/?page=2`);
      await expect(page.locator('.catalog-product')).toHaveCount(5);
      await expect(names(page).first()).toHaveText('Edge 10 Bivy');
      await expect(names(page).last()).toHaveText('Edge 14 Last Item');
      await expect(page.locator('.catalog-count')).toHaveText('14 products');
      await expect(pager(page).locator('.page-status')).toHaveText('2 / 2');
      await expect(errorBar(page)).toHaveCount(0);
    });
  });

  test('TC-BUG-12-08 un-fixme\'d catalog-browse spec has the page tests enabled', async () => {
    const spec = fs.readFileSync(path.join(root, 'e2e', 'teststack', 'catalog-browse.spec.ts'), 'utf8');
    await test.step('grep fixme in catalog-browse.spec.ts', async () => {
      expect(spec).not.toMatch(/fixme/i);
    });
    await test.step('the ?page=0 and ?page=-1 tests are defined as regular tests', async () => {
      expect(spec).toContain("for (const pageParam of ['0', '-1'])");
      expect(spec).toContain('test(`?page=${pageParam} shows the first page`');
    });
  });

  test('TC-BUG-12-09 bug row removed from the bugs table in testing/flows/catalog.md', async () => {
    const dir = path.join(root, 'testing', 'flows');
    await test.step('grep page=0 / page=-1 in testing/flows/*.md', async () => {
      const lines = fs
        .readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').map(l => ({ f, l })))
        .filter(({ l }) => /page=0|page=-1/i.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const { f, l } of lines) {
        // No bugs-table row, and the mention says the pages are treated as page 1.
        expect(l.trimStart().startsWith('|'), `${f}: ${l}`).toBe(false);
        expect(l, `${f}: ${l}`).toMatch(/treated as page 1/);
        expect(l, `${f}: ${l}`).not.toMatch(/never loads|not load|hang|broken/i);
      }
    });
  });
});
