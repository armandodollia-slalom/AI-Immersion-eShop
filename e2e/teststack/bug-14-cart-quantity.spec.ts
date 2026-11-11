import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario, login } from './scenario';
import { redisBasket, USER_IDS } from './auth-basket-helpers';

// Scenario bug-14 (extends basket-edge): bob has Explorer 45L Backpack (id 7) x2 and Carbon Fiber Trekking Poles x1.
const BACKPACK = { id: 7, name: 'Explorer 45L Backpack' };

test.describe.configure({ mode: 'serial' });

function backpackQuantity(): number | undefined {
  return redisBasket(USER_IDS.bob)?.Items.find(i => i.ProductId === BACKPACK.id)?.Quantity;
}

async function openBobCart(page: Page) {
  await login(page, 'bob');
  await page.goto('/cart');
  await expect(page.getByRole('heading', { name: 'Shopping bag', exact: true })).toBeVisible();
  const row = page.locator('.cart-item').filter({ has: page.getByText(BACKPACK.name, { exact: true }) });
  return {
    qty: row.locator('[data-cart-quantity-input]'),
    decrease: row.getByRole('button', { name: `Decrease quantity of ${BACKPACK.name}` }),
  };
}

async function typeAndEnter(page: Page, qty: ReturnType<Page['locator']>, value: string) {
  const posted = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/cart');
  await Promise.all([posted, (async () => { await qty.fill(value); await qty.press('Enter'); })()]);
}

function cartPosts(page: Page): Request[] {
  const posts: Request[] = [];
  page.on('request', r => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/cart') posts.push(r);
  });
  return posts;
}

test.describe('BUG-14: cart quantity Enter-commit then blur', () => {
  test.beforeEach(() => {
    loadScenario('bug-14');
  });

  test('TC-BUG-14-01 Enter then Decrease stores the decremented quantity', async ({ browser }) => {
    test.setTimeout(180_000);
    for (let run = 1; run <= 5; run++) {
      if (run > 1) loadScenario('bug-14');
      const page = await (await browser.newContext()).newPage();
      await test.step(`run ${run}: sign in as bob and open the cart`, async () => {
        const { qty, decrease } = await openBobCart(page);
        await test.step('fill 5 and press Enter; wait for the submit', async () => {
          await typeAndEnter(page, qty, '5');
          await expect.poll(backpackQuantity).toBe(5);
        });
        await test.step('immediately click Decrease', async () => {
          await decrease.click();
          await expect(qty).toHaveValue('4');
        });
        await test.step('wait 1 second and read Redis', async () => {
          await page.waitForTimeout(1000);
          expect(backpackQuantity()).toBe(4);
        });
      });
      await page.context().close();
    }
  });

  test('TC-BUG-14-02 Enter then Decrease sends exactly one cart POST', async ({ page }) => {
    const { qty, decrease } = await openBobCart(page);
    await test.step('fill 5, press Enter, wait for the submit', async () => {
      await typeAndEnter(page, qty, '5');
      await expect.poll(backpackQuantity).toBe(5);
    });
    const posts = cartPosts(page);
    await test.step('click Decrease and wait for the UI to settle', async () => {
      await decrease.click();
      await expect(qty).toHaveValue('4');
      await page.waitForTimeout(1000);
    });
    await test.step('exactly one POST, from the Decrease button, none carrying 5', async () => {
      expect(posts).toHaveLength(1);
      const body = new URLSearchParams(posts[0].postData() ?? '');
      // Decrease and the hidden apply button share the name UpdateQuantityValue; they differ by value.
      // Decrease carries quantity-1 = 4; the apply submitter would carry the typed 5.
      expect(body.getAll('UpdateQuantityValue')).toEqual(['4']);
      expect(body.get('UpdateQuantityId')).toBe(String(BACKPACK.id));
      expect([...body.values()]).not.toContain('5');
      await expect(qty).toHaveValue('4');
      expect(backpackQuantity()).toBe(4);
    });
  });

  test('TC-BUG-14-03 typing a new value after Enter and blurring still commits it', async ({ page }) => {
    const { qty } = await openBobCart(page);
    await test.step('fill 5 and press Enter; wait for the submit', async () => {
      await typeAndEnter(page, qty, '5');
      await expect.poll(backpackQuantity).toBe(5);
    });
    await test.step('type 7 (no Enter), then click an empty area to blur', async () => {
      const posted = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/cart');
      await qty.fill('7');
      await Promise.all([posted, page.mouse.click(2, 2)]);
    });
    await test.step('box shows 7 and Redis holds 7', async () => {
      await expect(qty).toHaveValue('7');
      await expect.poll(backpackQuantity).toBe(7);
    });
  });

  test('TC-BUG-14-04 typing a value and blurring without Enter commits it once', async ({ page }) => {
    const { qty } = await openBobCart(page);
    const posts = cartPosts(page);
    await test.step('fill 6 (no Enter), then click an empty area to blur', async () => {
      const posted = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/cart');
      await qty.fill('6');
      await Promise.all([posted, page.mouse.click(2, 2)]);
      await page.waitForTimeout(1000);
    });
    await test.step('exactly one POST carrying 6; box and Redis show 6', async () => {
      expect(posts).toHaveLength(1);
      expect([...new URLSearchParams(posts[0].postData() ?? '').values()]).toContain('6');
      await expect(qty).toHaveValue('6');
      await expect.poll(backpackQuantity).toBe(6);
    });
  });

  test('TC-BUG-14-05 basket cart spec passes with the fixme marker removed', async () => {
    test.setTimeout(600_000);
    const specPath = path.join(__dirname, 'basket-cart.spec.ts');
    await test.step('the fixme marker is gone from basket-cart.spec.ts', async () => {
      const spec = fs.readFileSync(specPath, 'utf8');
      expect(spec).not.toMatch(/test\.fixme/);
      expect(spec).toMatch(/^\s*test\('typing a quantity, pressing Enter, then clicking Decrease reliably/m);
    });
    await test.step('run basket-cart.spec.ts: exit code 0, nothing skipped or failed', async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug14-basket-cart-'));
      const run = spawnSync(
        'npx',
        ['playwright', 'test', '-c', 'playwright.teststack.config.ts', '--project', 'scenarios', '--no-deps',
          '--reporter=json', '--output', outDir, 'e2e/teststack/basket-cart.spec.ts'],
        { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, E2E_KEEP_VIDEOS: '' } },
      );
      const report = JSON.parse(run.stdout);
      expect(report.stats.expected).toBeGreaterThan(0);
      expect(report.stats.unexpected).toBe(0);
      expect(report.stats.flaky).toBe(0);
      expect(report.stats.skipped).toBe(0);
      expect(run.status).toBe(0);
    });
  });
});
