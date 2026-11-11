import { test, expect } from '../fixtures';
import { execFileSync } from 'child_process';
import path from 'path';
import { loadScenario, login } from './scenario';

const TESTSTACK = path.join(__dirname, '..', '..', 'testing', 'teststack');

function webappLogsSince(since: string): string {
  return execFileSync(TESTSTACK, ['logs', 'webapp', '--no-color', '--since', since], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function expectNoKeyNotFound(since: string) {
  const logs = webappLogsSince(since);
  expect(logs).not.toMatch(/KeyNotFoundException/);
  expect(logs).not.toContain('99999');
}

test.describe.configure({ mode: 'serial' });

test.describe('BUG-7: basket line for a product missing from the catalog', () => {
  test.beforeAll(() => {
    loadScenario('bug-7');
  });

  test('TC-BUG-7-01 home page loads for oscar despite a missing-product basket line', async ({ page }) => {
    const startedAt = new Date().toISOString();
    await test.step('Sign in as oscar', async () => {
      await login(page, 'oscar');
    });
    await test.step('Open the home page', async () => {
      await page.goto('/');
    });
    await test.step('Catalog renders with the cart menu and no error page', async () => {
      await expect(page.getByRole('heading', { name: 'Ready for a new adventure?' })).toBeVisible();
      await expect(page.locator('.catalog-item').first()).toBeVisible();
      await expect(page.locator('a[aria-label^="Shopping bag"]')).toBeVisible();
      await expect(page.getByText('An unhandled exception')).toHaveCount(0);
      await expect(page.getByText('KeyNotFoundException')).toHaveCount(0);
    });
    await test.step('WebApp logs contain no KeyNotFoundException for key 99999', async () => {
      expectNoKeyNotFound(startedAt);
    });
  });

  test('TC-BUG-7-02 cart page shows the valid line and omits the missing product', async ({ page }) => {
    const startedAt = new Date().toISOString();
    await test.step('Sign in as oscar', async () => {
      await login(page, 'oscar');
    });
    await test.step('Open the cart page', async () => {
      await page.goto('/cart');
      await expect(page.getByRole('heading', { name: 'Shopping bag', exact: true })).toBeVisible();
    });
    await test.step('Only the Explorer 45L Backpack line is shown', async () => {
      await expect(page.locator('.cart-item')).toHaveCount(1);
      await expect(page.locator('.cart-item').getByText('Explorer 45L Backpack', { exact: true })).toBeVisible();
      await expect(page.getByText('Discontinued Widget')).toHaveCount(0);
      await expect(page.getByText('KeyNotFoundException')).toHaveCount(0);
    });
    await test.step('WebApp logs contain no KeyNotFoundException for key 99999', async () => {
      expectNoKeyNotFound(startedAt);
    });
  });

  test('TC-BUG-7-03 item detail page still loads when the basket references a missing product', async ({ page }) => {
    const startedAt = new Date().toISOString();
    await test.step('Sign in as oscar', async () => {
      await login(page, 'oscar');
    });
    await test.step('Open the item page for product 7', async () => {
      const response = await page.goto('/item/7');
      expect(response?.status()).toBe(200);
    });
    await test.step('Item details and cart menu render, no error page', async () => {
      await expect(page.getByRole('heading', { name: 'Explorer 45L Backpack' })).toBeVisible();
      await expect(page.locator('a[aria-label^="Shopping bag"]')).toBeVisible();
      await expect(page.getByText('KeyNotFoundException')).toHaveCount(0);
    });
    await test.step('WebApp logs contain no KeyNotFoundException for key 99999', async () => {
      expectNoKeyNotFound(startedAt);
    });
  });
});
