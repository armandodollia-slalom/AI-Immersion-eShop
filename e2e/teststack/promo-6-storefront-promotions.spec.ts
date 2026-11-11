/// <reference types="node" />
import { execFileSync, spawnSync } from 'node:child_process';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { DOCKER, loadScenario } from './scenario';
import { getTokens } from './auth-basket-helpers';
import { SLOT, WEBAPP_URL, CATALOG_URL, port } from './ports';

// PROMO-6: tests/plans/PROMO-6-storefront-promotion-display (the e2e cases; the unit cases are in
// tests/WebApp.UnitTests). Scenario: testing/scenarios/promo-6 (seven promotions: 1 Fall Hiking Sale 20% off type 3,
// 2 Buy 2 Get 1 Free on product 40, 3 AmountOffOrder on All, 4 coupon-only, 5 Draft, 6 ended, 7 not started); TC-15 uses
// `default` (no promotions). The WebApp is restarted before every case so its /active cache is empty.
const PROMOTIONS_API = `http://localhost:${port('promotions')}/api/promotions`;
const V = 'api-version=1.0';
const ACTIVE = `${PROMOTIONS_API}/active?${V}`;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const COUNTDOWN = /^\d+d \d+h \d+m left$/;
const WARNING = 'Could not load active promotions; showing regular prices';

const project = () => (SLOT === 0 ? 'eshop-teststack' : `eshop-teststack-${SLOT}`);
const container = (service: string) => `${project()}-${service}-1`;
const docker = (...args: string[]) => execFileSync(DOCKER, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** WebApp container output (stdout and stderr) since the given time. */
const webAppLogs = (since: string) => {
  const result = spawnSync(DOCKER, ['logs', '--since', since, container('webapp')], { encoding: 'utf8' });
  return `${result.stdout}\n${result.stderr}`;
};
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  loadScenario('promo-6');
  adminToken = (await getTokens('alice', 'Pass123$', 'openid profile promotions')).access_token;
});

test.afterEach(() => {
  // Cases that stop or pause Promotions.API must leave it running for the next one.
  for (const command of [['unpause'], ['start']]) {
    try {
      docker(...command, container('promotions-api'));
    } catch {
      // already running
    }
  }
});

/** Restart the WebApp container (empties its /active cache) and wait until it serves the home page again. */
async function restartWebApp() {
  docker('restart', container('webapp'));
  await expect
    .poll(async () => {
      try {
        return (await fetch(WEBAPP_URL, { signal: AbortSignal.timeout(5000) })).status;
      } catch {
        return 0;
      }
    }, { timeout: 90_000, intervals: [500] })
    .toBe(200);
}

async function freshStack(scenario = 'promo-6') {
  loadScenario(scenario);
  await restartWebApp();
}

// ---- helpers -----------------------------------------------------------------------------------------------

/** Page (1-based) of the unfiltered catalog that lists the item: the catalog is ordered by name, 9 items per page. */
async function catalogPageOf(request: APIRequestContext, itemId: number): Promise<number> {
  const response = await request.get(`${CATALOG_URL}/api/catalog/items?pageIndex=0&pageSize=200&${V}`);
  expect(response.status()).toBe(200);
  const ids: number[] = (await response.json()).data.map((i: { id: number }) => i.id);
  const index = ids.indexOf(itemId);
  expect(index, `item ${itemId} in the catalog`).toBeGreaterThanOrEqual(0);
  return Math.floor(index / 9) + 1;
}

const grid = (page: Page) => page.locator('.catalog-items');
const tile = (page: Page, itemId: number): Locator => page.locator('.catalog-item', { has: page.locator(`a[href="item/${itemId}"]`) });
const banner = (page: Page) => page.locator('[data-promo-banner]');

/** Open the catalog page that lists the item (page 1 of `/` when it is on it) and wait for its tile. */
async function openCatalogWith(page: Page, request: APIRequestContext, itemId: number) {
  const n = await catalogPageOf(request, itemId);
  await page.goto(n === 1 ? '/' : `/?page=${n}`);
  await expect(tile(page, itemId)).toBeVisible();
}

async function openHome(page: Page) {
  await page.goto('/');
  await expect(grid(page)).toBeVisible();
  await expect(tile(page, 3)).toBeVisible();
}

async function expectNoPromotionMarkup(scope: Locator) {
  await expect(scope.locator('.promotion-badge')).toHaveCount(0);
  await expect(scope.locator('s')).toHaveCount(0);
  await expect(scope.locator('.price-original')).toHaveCount(0);
  await expect(scope.locator('.price-sale')).toHaveCount(0);
}

const trim = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim();

function adminPost(request: APIRequestContext, path: string, data?: Record<string, unknown>) {
  return request.post(`${PROMOTIONS_API}${path}?${V}`, { headers: bearer(adminToken), data });
}

/** Create and publish an already-started PercentOff promotion on one Product; returns its id. */
async function publishProductPromotion(request: APIRequestContext, productId: number, name: string, description: string, priority: number): Promise<number> {
  const created = await adminPost(request, '', {
    name,
    description,
    type: 'PercentOff',
    value: 50,
    startsAt: new Date(Date.now() - HOUR).toISOString(),
    endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
    priority,
    isStackable: false,
    requiresCoupon: false,
    targets: [{ scope: 'Product', targetId: productId }],
  });
  expect(created.status(), await created.text()).toBe(201);
  const id: number = (await created.json()).id;
  const published = await adminPost(request, `/${id}/publish`);
  expect(published.status(), await published.text()).toBe(200);
  return id;
}

async function waitForItemPromotion(page: Page, itemId: number, name: string) {
  await expect(async () => {
    await page.goto(`/item/${itemId}`);
    await expect(page.locator('.item-promotion')).toContainText(name, { timeout: 2000 });
  }).toPass({ timeout: 30_000, intervals: [1000] });
}

function promotionsSql(sql: string) {
  docker('exec', '-e', 'PGPASSWORD=teststack-postgres', container('postgres'), 'psql', '-U', 'postgres', '-d', 'promotionsdb', '-c', sql);
}

// ---- catalog -----------------------------------------------------------------------------------------------

test('TC-PROMO-6-01 type-3 catalog items show -20%, the crossed-out price and the sale price', async ({ page, request }) => {
  await freshStack();
  const expected = [
    { id: 3, original: '$79.99', sale: '$63.99' },
    { id: 5, original: '$299.99', sale: '$239.99' },
    { id: 12, original: '$399.00', sale: '$319.20' },
  ];
  for (const item of expected) {
    await test.step(`open the catalog and read the tile of item ${item.id}`, async () => {
      await openCatalogWith(page, request, item.id);
      const t = tile(page, item.id);
      await expect(t.locator('.promotion-badge')).toHaveCount(1);
      await expect(t.locator('.promotion-badge')).toHaveText('-20%');
      await expect(t.locator('s')).toHaveCount(1);
      await expect(t.locator('.price-original')).toHaveText(item.original);
      expect(await t.locator('s').evaluate(el => el.classList.contains('price-original'))).toBe(true);
      await expect(t.locator('.price-sale')).toHaveText(item.sale);
    });
  }
});

test('TC-PROMO-6-02 items outside the promotion type look the same as without promotions', async ({ page, request }) => {
  await freshStack();
  for (const item of [{ id: 1, price: '$109.99' }, { id: 24, price: '$69.99' }, { id: 7, price: '$149.99' }]) {
    await test.step(`read the tile of item ${item.id}`, async () => {
      await openCatalogWith(page, request, item.id);
      const t = tile(page, item.id);
      await expectNoPromotionMarkup(t);
      await expect(t.locator('.price')).toHaveCount(1);
      await expect(t.locator('.price')).toHaveText(item.price);
    });
  }
});

test('TC-PROMO-6-03 BuyXGetY item shows its badge but no crossed-out or sale price', async ({ page, request }) => {
  await freshStack();
  await test.step('open the catalog page of item 40', async () => {
    await openCatalogWith(page, request, 40);
  });
  await test.step('read the tile of item 40', async () => {
    const t = tile(page, 40);
    await expect(t.locator('.promotion-badge')).toHaveText('Buy 2 Get 1');
    await expect(t.locator('s')).toHaveCount(0);
    await expect(t.locator('.price-original')).toHaveCount(0);
    await expect(t.locator('.price-sale')).toHaveCount(0);
    await expect(t.locator('.price')).toHaveText('$99.99');
  });
});

// ---- item page ---------------------------------------------------------------------------------------------

test('TC-PROMO-6-04 type-3 item page shows the promotion name and end date next to the price', async ({ page, request }) => {
  await freshStack();
  let endDate = '';
  await test.step('read endsAt of promotion 1 from /active', async () => {
    const response = await request.get(ACTIVE);
    expect(response.status()).toBe(200);
    const promotion = (await response.json()).find((p: { id: number }) => p.id === 1);
    // Format in the offset the API returned, as the WebApp does (ddd MMM d).
    const day = new Date(`${(promotion.endsAt as string).slice(0, 10)}T00:00:00Z`);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day.getUTCDay()];
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][day.getUTCMonth()];
    endDate = `${weekday} ${month} ${day.getUTCDate()}`;
  });
  await test.step('open /item/3', async () => {
    await page.goto('/item/3');
    const row = page.locator('.add-to-cart .item-promotion');
    await expect(row).toHaveCount(1);
    expect(trim(await row.textContent()).startsWith('Fall Hiking Sale:')).toBe(true);
    expect(trim(await row.textContent())).toContain(`ends ${endDate}`);
    await expect(page.locator('.add-to-cart .price')).toContainText('$79.99');
  });
});

test('TC-PROMO-6-05 item page of a non-matching item has no promotion row', async ({ page }) => {
  await freshStack();
  await test.step('open /item/1', async () => {
    await page.goto('/item/1');
    await expect(page.locator('.add-to-cart .price')).toHaveText('$109.99');
  });
  await test.step('check the price area', async () => {
    await expect(page.locator('.item-promotion')).toHaveCount(0);
    const area = trim(await page.locator('.add-to-cart').textContent());
    expect(area).not.toContain('$10 off');
    expect(area).not.toContain('Coupon only');
  });
});

test('TC-PROMO-6-06 item page shows the highest-priority matching promotion', async ({ page, request }) => {
  await freshStack();
  await test.step('open /item/3 to fill the cache', async () => {
    await page.goto('/item/3');
    await expect(page.locator('.item-promotion')).toContainText('Fall Hiking Sale');
  });
  await test.step('create and publish Flash Snowboard Deal (priority 20, product 3)', async () => {
    await publishProductPromotion(request, 3, 'Flash Snowboard Deal', 'Half price on goggles', 20);
  });
  await test.step('poll /item/3 until the new promotion shows', async () => {
    await waitForItemPromotion(page, 3, 'Flash Snowboard Deal');
    expect(trim(await page.locator('.item-promotion').textContent()).startsWith('Flash Snowboard Deal:')).toBe(true);
    await expect(page.locator('.item-promotion')).not.toContainText('Fall Hiking Sale');
  });
  await test.step('/item/5 still shows Fall Hiking Sale', async () => {
    await page.goto('/item/5');
    expect(trim(await page.locator('.item-promotion').textContent()).startsWith('Fall Hiking Sale:')).toBe(true);
  });
});

// ---- banner ------------------------------------------------------------------------------------------------

test('TC-PROMO-6-07 banner shows the highest-priority promotion description, countdown and link', async ({ page }) => {
  await freshStack();
  await test.step('open / and wait for the banner', async () => {
    await page.goto('/');
    await expect(banner(page)).toBeVisible();
  });
  await test.step('check text, countdown and link', async () => {
    await expect(banner(page)).toContainText('20% off all hiking gear');
    await expect(banner(page)).not.toContainText('$10 off your order');
    const countdown = banner(page).locator('[data-promo-countdown]');
    await expect(countdown).toHaveText(COUNTDOWN);
    expect((await countdown.textContent())!.split('d ')[0]).toBe('89');
    await expect(banner(page).getByRole('link', { name: 'Shop the sale' })).toBeVisible();
    // Directly under the header bar: the banner is rendered before the page content.
    const header = await page.locator('header').first().boundingBox();
    const box = await banner(page).boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
  });
});

test('TC-PROMO-6-08 banner is also shown on an item page', async ({ page }) => {
  await freshStack();
  await test.step('open /item/1', async () => {
    await page.goto('/item/1');
    await expect(banner(page)).toBeVisible();
  });
  await test.step('check the banner', async () => {
    await expect(banner(page)).toContainText('20% off all hiking gear');
    await expect(banner(page).locator('[data-promo-countdown]')).toHaveText(COUNTDOWN);
  });
});

test('TC-PROMO-6-09 Shop the sale opens the catalog filtered to the promotion type', async ({ page }) => {
  await freshStack();
  await test.step('open /item/1', async () => {
    await page.goto('/item/1');
    await expect(banner(page)).toBeVisible();
  });
  const link = banner(page).getByRole('link', { name: 'Shop the sale' });
  await test.step('click Shop the sale', async () => {
    await expect(link).toHaveAttribute('href', '/?type=3');
    await link.click();
    await expect(page).toHaveURL(/\/\?type=3$/);
  });
  await test.step('the grid shows only type-3 items', async () => {
    await expect(grid(page)).toBeVisible();
    await expect(tile(page, 3)).toBeVisible();
    await expect(tile(page, 5)).toBeVisible();
    await expect(tile(page, 1)).toHaveCount(0);
    await expect(tile(page, 24)).toHaveCount(0);
    // Every tile on the page is type 3: all show the type-3 promotion's -20% badge.
    const tiles = await page.locator('.catalog-item').count();
    expect(tiles).toBeGreaterThan(0);
    await expect(page.locator('.catalog-item .promotion-badge')).toHaveCount(tiles);
  });
});

test('TC-PROMO-6-10 banner countdown updates in the browser without a reload', async ({ page, request }) => {
  await freshStack();
  let first = '';
  await test.step('install the fake clock and open /', async () => {
    // Start the page clock 5d 3h 30m 30s before the end, so the minute never rolls over by itself during the case.
    const promotion = (await (await request.get(ACTIVE)).json()).find((p: { id: number }) => p.id === 1);
    await page.clock.install({ time: new Date(Date.parse(promotion.endsAt) - (5 * DAY + 3 * HOUR + 30 * 60_000 + 30_000)) });
    await page.goto('/');
    await expect(banner(page)).toBeVisible();
    await expect(banner(page).locator('[data-promo-countdown]')).toHaveText('5d 3h 30m left');
    first = (await banner(page).locator('[data-promo-countdown]').textContent())!;
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
  });
  await test.step('advance the clock by 60 seconds', async () => {
    await page.clock.runFor(60_000);
  });
  await test.step('the countdown shows one minute less and nothing reloaded', async () => {
    const countdown = banner(page).locator('[data-promo-countdown]');
    await expect(countdown).toHaveText('5d 3h 29m left');
    expect(await countdown.textContent()).not.toBe(first);
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
  });
});

test('TC-PROMO-6-11 banner hides itself when the countdown reaches zero, without a reload', async ({ page }) => {
  await freshStack();
  await test.step('install the fake clock, open / and confirm the banner', async () => {
    await page.clock.install();
    await page.goto('/');
    await expect(banner(page)).toBeVisible();
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
  });
  await test.step('jump the clock 91 days ahead', async () => {
    // fastForward takes a duration that must fit in 31 bits (about 24 days), so jump in 7 x 13 days.
    for (let i = 0; i < 7; i++) await page.clock.fastForward(13 * DAY);
    await page.clock.runFor(1000);
  });
  await test.step('the banner is hidden, the page was not reloaded', async () => {
    await expect(banner(page)).toBeHidden({ timeout: 1000 });
    await expect(banner(page)).toHaveAttribute('hidden', '');
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
    await expect(grid(page)).toBeVisible();
  });
});

test('TC-PROMO-6-12 banner skips a higher-priority promotion that targets only a Product', async ({ page, request }) => {
  await freshStack();
  await test.step('create and publish Flash Snowboard Deal (priority 20, product 3)', async () => {
    await publishProductPromotion(request, 3, 'Flash Snowboard Deal', 'Half price on goggles', 20);
  });
  await test.step('poll /item/3 until the WebApp sees it', async () => {
    await waitForItemPromotion(page, 3, 'Flash Snowboard Deal');
  });
  await test.step('open / and read the banner', async () => {
    await page.goto('/');
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText('20% off all hiking gear');
    await expect(banner(page)).not.toContainText('Half price on goggles');
    await expect(banner(page).getByRole('link', { name: 'Shop the sale' })).toHaveAttribute('href', '/?type=3');
  });
});

// ---- events ------------------------------------------------------------------------------------------------

test('TC-PROMO-6-13 PromotionEndedIntegrationEvent removes the badge and banner on every later page load', async ({ page, request }) => {
  await freshStack();
  await test.step('open / and /item/3 to fill the cache', async () => {
    await openHome(page);
    await expect(tile(page, 3).locator('.promotion-badge')).toHaveText('-20%');
    await expect(banner(page)).toContainText('20% off all hiking gear');
    await page.goto('/item/3');
    await expect(page.locator('.item-promotion')).toContainText('Fall Hiking Sale');
  });
  await test.step('end promotion 1', async () => {
    const response = await adminPost(request, '/1/end');
    expect(response.ok(), await response.text()).toBe(true);
  });
  await test.step('poll / until item 3 has no badge', async () => {
    await expect(async () => {
      await openHome(page);
      await expect(tile(page, 3).locator('.promotion-badge')).toHaveCount(0, { timeout: 2000 });
    }).toPass({ timeout: 30_000, intervals: [1000] });
    await expectNoPromotionMarkup(tile(page, 3));
    await expect(tile(page, 3).locator('.price')).toHaveText('$79.99');
  });
  await test.step('reload / twice more and open /item/3', async () => {
    for (let i = 0; i < 2; i++) {
      await openHome(page);
      await expect(banner(page)).not.toContainText('20% off all hiking gear');
    }
    // The next-highest active All promotion (3) now owns the banner, linking to the whole catalog.
    await expect(banner(page)).toContainText('$10 off your order when you spend $150 or more');
    await expect(banner(page).getByRole('link', { name: 'Shop the sale' })).toHaveAttribute('href', '/');
    await page.goto('/item/3');
    await expect(banner(page)).not.toContainText('20% off all hiking gear');
    await expect(page.locator('.item-promotion')).toHaveCount(0);
  });
});

test('TC-PROMO-6-14 PromotionStartedIntegrationEvent makes a newly published promotion visible', async ({ page, request }) => {
  await freshStack();
  await test.step('open / and confirm item 1 has no badge', async () => {
    await openCatalogWith(page, request, 1);
    await expect(tile(page, 1).locator('.promotion-badge')).toHaveCount(0);
  });
  await test.step('publish promotion 5', async () => {
    const response = await adminPost(request, '/5/publish');
    expect(response.ok(), await response.text()).toBe(true);
  });
  await test.step('poll / until item 1 shows -5%', async () => {
    await expect(async () => {
      await openCatalogWith(page, request, 1);
      await expect(tile(page, 1).locator('.promotion-badge')).toHaveText('-5%', { timeout: 2000 });
    }).toPass({ timeout: 30_000, intervals: [1000] });
    await expect(tile(page, 1).locator('.price-original')).toHaveText('$109.99');
    await expect(tile(page, 1).locator('.price-sale')).toHaveText('$104.49');
  });
  await test.step('item 3 still shows -20%', async () => {
    await openHome(page);
    await expect(tile(page, 3).locator('.promotion-badge')).toHaveText('-20%');
  });
});

// ---- no promotions, outages, coupons -----------------------------------------------------------------------

test('TC-PROMO-6-15 with no active promotions every page renders as today', async ({ page }) => {
  await freshStack('default');
  await test.step('open /', async () => {
    await openHome(page);
    await expect(banner(page)).toHaveCount(0);
    await expectNoPromotionMarkup(page.locator('.catalog-items'));
    await expect(tile(page, 3).locator('.price')).toHaveText('$79.99');
  });
  await test.step('open /item/3', async () => {
    await page.goto('/item/3');
    await expect(page.locator('.add-to-cart .price')).toHaveText('$79.99');
    await expect(banner(page)).toHaveCount(0);
    await expect(page.locator('.item-promotion')).toHaveCount(0);
    await expectNoPromotionMarkup(page.locator('main, body').first());
  });
});

test('TC-PROMO-6-16 pages render at normal prices with a warning logged when Promotions.API is down', async ({ page }) => {
  loadScenario('promo-6');
  docker('stop', container('promotions-api'));
  await restartWebApp();
  const since = new Date(Date.now() - 5000).toISOString();
  await test.step('open / and /item/3', async () => {
    const home = await page.goto('/');
    expect(home!.status()).toBe(200);
    await expect(grid(page)).toBeVisible();
    await expect(tile(page, 3).locator('.price')).toHaveText('$79.99');
    const item = await page.goto('/item/3');
    expect(item!.status()).toBe(200);
    await expect(page.locator('.add-to-cart .price')).toHaveText('$79.99');
    await expect(banner(page)).toHaveCount(0);
    await expect(page.locator('.item-promotion')).toHaveCount(0);
    await expectNoPromotionMarkup(page.locator('body'));
    await page.goto('/');
    await expect(banner(page)).toHaveCount(0);
    await expectNoPromotionMarkup(grid(page));
  });
  await test.step('read the WebApp logs', async () => {
    // Console log format: a "warn: <category>[id]" line, then the message on the next line.
    const warning = () => {
      const lines = webAppLogs(since).split('\n');
      const at = lines.findIndex(line => line.includes(WARNING));
      return at < 0 ? '' : `${lines[at - 1] ?? ''}\n${lines[at]}`;
    };
    await expect.poll(warning, { timeout: 15_000 }).toContain(WARNING);
    expect(warning()).toMatch(/^warn:/);
  });
});

test('TC-PROMO-6-17 a hanging Promotions.API delays a page load by at most the 2s timeout', async ({ page }) => {
  loadScenario('promo-6');
  await restartWebApp();
  async function timeHome() {
    const started = Date.now();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(tile(page, 3)).toBeVisible({ timeout: 30_000 });
    return Date.now() - started;
  }
  let baseline = 0;
  await test.step('measure a baseline load of / with Promotions.API running', async () => {
    baseline = await timeHome();
    await expect(banner(page)).toBeVisible();
  });
  await test.step('pause Promotions.API and restart the WebApp', async () => {
    docker('pause', container('promotions-api'));
    await restartWebApp();
  });
  await test.step('navigate to / and time it', async () => {
    const elapsed = await timeHome();
    await expect(tile(page, 3).locator('.price')).toHaveText('$79.99');
    await expect(banner(page)).toHaveCount(0);
    await expectNoPromotionMarkup(grid(page));
    expect(elapsed, `elapsed ${elapsed} ms vs baseline ${baseline} ms`).toBeLessThanOrEqual(baseline + 2000 + 1500);
  });
});

test('TC-PROMO-6-18 a coupon-only promotion is never shown on the storefront', async ({ page }) => {
  loadScenario('promo-6');
  promotionsSql('UPDATE "Promotions" SET "Priority" = 100 WHERE "Id" = 4');
  await restartWebApp();
  await test.step('open /', async () => {
    await openHome(page);
    await expect(banner(page)).toBeVisible();
    expect(trim(await banner(page).textContent())).toContain('20% off all hiking gear');
    await expect(banner(page)).not.toContainText('10% off everything with a coupon code');
    await expect(tile(page, 3).locator('.promotion-badge')).toHaveText('-20%');
    await expect(page.locator('.catalog-item .promotion-badge')).not.toContainText('-10%');
    for (const text of ['FALL10', 'WELCOME5', 'Coupon only']) {
      await expect(page.locator('body')).not.toContainText(text);
    }
  });
  await test.step('open /item/1', async () => {
    await page.goto('/item/1');
    await expect(page.locator('.add-to-cart .price')).toHaveText('$109.99');
    await expect(page.locator('.promotion-badge')).toHaveCount(0);
    await expect(page.locator('.item-promotion')).toHaveCount(0);
    await expect(banner(page)).not.toContainText('10% off everything with a coupon code');
    for (const text of ['FALL10', 'WELCOME5', 'Coupon only']) {
      await expect(page.locator('body')).not.toContainText(text);
    }
  });
});
