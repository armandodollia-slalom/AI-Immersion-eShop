/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect } from '../fixtures';
import { DOCKER, loadScenario } from './scenario';
import { getTokens } from './auth-basket-helpers';
import { SLOT, port } from './ports';

// PROMO-3: tests/plans/PROMO-3-cart-pricing-evaluation-api. POST /api/promotions/evaluate against the Promotions.API
// container of the test stack (real Postgres, tokens issued by the real Identity.API). Scenario: testing/scenarios/promo-3
// (= promo-2): promotions 1-7 as the plan lists them. Promotions a case needs beyond the seed are created through the
// admin API (create, then publish), so their ids start at 8. The database is reset before every case and the
// Promotions.API container is restarted so its 30 s promotion cache starts empty.
const PROMOTIONS_URL = `http://localhost:${port('promotions')}`;
const API = `${PROMOTIONS_URL}/api/promotions`;
const V = 'api-version=1.0';
const EVALUATE = `${API}/evaluate?${V}`;

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const VALIDATION_TITLE = 'One or more validation errors occurred.';

let adminToken = '';
let bobToken = '';

const stackProject = () => (SLOT === 0 ? 'eshop-teststack' : `eshop-teststack-${SLOT}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Restart Promotions.API (the cache lives in its memory) and wait until it answers again. */
async function restartPromotions(request: APIRequestContext) {
  execFileSync(DOCKER, ['restart', `${stackProject()}-promotions-api-1`], { stdio: 'ignore' });
  await expect
    .poll(async () => (await request.get(`${API}/active?${V}`).catch(() => null))?.status() ?? 0, { timeout: 90 * SECOND, intervals: [500] })
    .toBe(200);
}

test.beforeAll(async () => {
  loadScenario('promo-3');
  adminToken = (await getTokens('alice', 'Pass123$', 'openid profile promotions')).access_token;
  bobToken = (await getTokens('bob', 'Pass123$', 'openid profile promotions')).access_token;
});

test.beforeEach(async ({ request }) => {
  loadScenario('promo-3');
  await restartPromotions(request);
});

// ---- helpers -----------------------------------------------------------------------------------------------

interface Line { productId: number; catalogTypeId: number; catalogBrandId: number; unitPrice: number; quantity: number }
const line = (productId: number, catalogTypeId: number, catalogBrandId: number, unitPrice: number, quantity = 1): Line => ({
  productId, catalogTypeId, catalogBrandId, unitPrice, quantity,
});

const evaluate = (request: APIRequestContext, body: unknown, token: string | null = adminToken) =>
  request.post(EVALUATE, { headers: token ? bearer(token) : {}, data: body });

const evaluateItems = (request: APIRequestContext, items: Line[], token: string | null = adminToken) => evaluate(request, { items }, token);

/** Promotion body for the admin API: Active as soon as it is published unless `change` says otherwise. */
const promotionBody = (change: Record<string, unknown>) => ({
  name: 'Extra promotion',
  description: 'Extra promotion of the case',
  type: 'PercentOff',
  value: 10,
  targets: [{ scope: 'All' }],
  startsAt: at(-HOUR),
  endsAt: at(30 * DAY),
  priority: 1,
  isStackable: false,
  requiresCoupon: false,
  ...change,
});

/** Create the promotion with the admin token, publish it (which also drops the cache) and return its id; the first one is 8. */
async function createAndPublish(request: APIRequestContext, change: Record<string, unknown>): Promise<number> {
  const created = await request.post(`${API}?${V}`, { headers: bearer(adminToken), data: promotionBody(change) });
  expect(created.status(), await created.text()).toBe(201);
  const id = (await created.json()).id as number;
  const published = await request.post(`${API}/${id}/publish?${V}`, { headers: bearer(adminToken) });
  expect(published.status(), await published.text()).toBe(200);
  return id;
}

/** Run SQL against promotionsdb and return the rows as objects. */
function promotionsSql<T = Record<string, unknown>>(sql: string): T[] {
  const wrapped = `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (${sql}) t`;
  const out = execFileSync(
    DOCKER,
    ['exec', '-e', 'PGPASSWORD=teststack-postgres', `${stackProject()}-postgres-1`, 'psql', '-U', 'postgres', '-d', 'promotionsdb', '-At', '-c', wrapped],
    { encoding: 'utf8' },
  ).trim();
  return JSON.parse(out);
}

const rowCounts = () =>
  promotionsSql<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM "Promotions") AS promotions, (SELECT count(*)::int FROM "PromotionTargets") AS targets,
            (SELECT count(*)::int FROM "Coupons") AS coupons, (SELECT count(*)::int FROM "IntegrationEventLog") AS events`,
  )[0];

interface Priced {
  subtotal: number;
  totalDiscount: number;
  total: number;
  lines: { productId: number; lineTotal: number; discount: number; appliedPromotionIds: number[] }[];
  appliedPromotions: { id: number; name: string; badgeLabel: string; savings: number }[];
  coupon: { code: string | null; status: string; reason?: string };
  nextThreshold: { promotionId: number; minOrderTotal: number; amountRemaining: number; reward: number } | null;
}

async function ok(response: APIResponse): Promise<Priced> {
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as Priced;
}

const totals = (priced: Priced, subtotal: number, totalDiscount: number, total: number) =>
  expect({ subtotal: priced.subtotal, totalDiscount: priced.totalDiscount, total: priced.total }).toEqual({ subtotal, totalDiscount, total });

const NEXT_THRESHOLD_3 = (amountRemaining: number) => ({ promotionId: 3, minOrderTotal: 150, amountRemaining, reward: 10 });

/** 400 ValidationProblem naming `key` and no pricing in the body. */
async function expectRejected(response: APIResponse, key: string) {
  expect(response.status()).toBe(400);
  const text = await response.text();
  const problem = JSON.parse(text);
  expect(problem.title).toBe(VALIDATION_TITLE);
  expect(Object.keys(problem.errors)).toContain(key);
  for (const field of ['subtotal', 'lines', 'appliedPromotions']) {
    expect(problem).not.toHaveProperty(field);
  }
}

/** The expectations shared by the Buy 2 Get 1 cases: one line of product 40 and promotion 2 as the only applied promotion. */
async function expectBuyTwoGetOne(request: APIRequestContext, quantity: number, lineTotal: number, discount: number) {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 40 at 15.00', async () => {
    priced = await ok(await evaluateItems(request, [line(40, 1, 5, 15, quantity)]));
  });
  await test.step('200 with the free units taken off and promotion 2 applied', async () => {
    totals(priced, lineTotal, discount, lineTotal - discount);
    expect(priced.lines).toEqual([{ productId: 40, lineTotal, discount, appliedPromotionIds: [2] }]);
    expect(priced.appliedPromotions).toEqual([{ id: 2, name: 'Buy 2 Get 1 Free', badgeLabel: 'Buy 2 Get 1', savings: discount }]);
  });
}

const hiking = (price = 89.99) => line(12, 3, 2, price);

// ---- Line discounts -----------------------------------------------------------------------------------------

test('TC-PROMO-3-01 cart with no matching items and no coupon gets no discount', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 99, 20.00 x 2', async () => {
    priced = await ok(await evaluateItems(request, [line(99, 9, 9, 20, 2)]));
  });
  await test.step('200 with no discount, NotProvided coupon and the closest threshold', async () => {
    totals(priced, 40, 0, 40);
    expect(priced.lines).toEqual([{ productId: 99, lineTotal: 40, discount: 0, appliedPromotionIds: [] }]);
    expect(priced.appliedPromotions).toEqual([]);
    expect(priced.coupon.status).toBe('NotProvided');
    expect(priced.coupon.reason ?? null).toBeNull();
    expect(priced.nextThreshold).toEqual(NEXT_THRESHOLD_3(110));
  });
});

test('TC-PROMO-3-02 one line matching a single PercentOff gets round(lineTotal x 0.20, 2)', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 12 (type 3), 89.99 x 1', async () => {
    priced = await ok(await evaluateItems(request, [hiking()]));
  });
  await test.step('200 with 18.00 off from promotion 1', async () => {
    totals(priced, 89.99, 18, 71.99);
    expect(priced.lines).toEqual([{ productId: 12, lineTotal: 89.99, discount: 18, appliedPromotionIds: [1] }]);
    expect(priced.appliedPromotions).toEqual([{ id: 1, name: 'Fall Hiking Sale', badgeLabel: '-20%', savings: 18 }]);
    expect(priced.coupon.status).toBe('NotProvided');
    expect(priced.nextThreshold).toEqual(NEXT_THRESHOLD_3(78.01));
  });
});

test('TC-PROMO-3-03 product 40 with quantity 3 gets 1 free unit', async ({ request }) => {
  await expectBuyTwoGetOne(request, 3, 45, 15);
});

test('TC-PROMO-3-04 product 40 with quantity 5 still gets only 1 free unit', async ({ request }) => {
  await expectBuyTwoGetOne(request, 5, 75, 15);
});

test('TC-PROMO-3-05 product 40 with quantity 6 gets 2 free units', async ({ request }) => {
  await expectBuyTwoGetOne(request, 6, 90, 30);
});

test('TC-PROMO-3-06 product 40 with quantity 2 gets no free unit and is not listed as applied', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 40, 15.00 x 2', async () => {
    priced = await ok(await evaluateItems(request, [line(40, 1, 5, 15, 2)]));
  });
  await test.step('200 with no discount and promotion 2 not listed', async () => {
    totals(priced, 30, 0, 30);
    expect(priced.lines).toEqual([{ productId: 40, lineTotal: 30, discount: 0, appliedPromotionIds: [] }]);
    expect(priced.appliedPromotions).toEqual([]);
  });
});

test('TC-PROMO-3-07 a promotion matches a line when any of its Brand or Product targets match', async ({ request }) => {
  let id = 0;
  await test.step('Create and publish promotion 8 (10% on Brand 5 and Product 55)', async () => {
    id = await createAndPublish(request, {
      name: 'Brand and Product 10%',
      value: 10,
      targets: [{ scope: 'Brand', targetId: 5 }, { scope: 'Product', targetId: 55 }],
    });
    expect(id).toBe(8);
  });
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with products 55, 56 and 57', async () => {
    priced = await ok(await evaluateItems(request, [line(55, 9, 1, 10), line(56, 9, 5, 10), line(57, 9, 2, 10)]));
  });
  await test.step('200 with 1.00 off products 55 (Product target) and 56 (Brand target), none off 57', async () => {
    totals(priced, 30, 2, 28);
    expect(priced.lines).toEqual([
      { productId: 55, lineTotal: 10, discount: 1, appliedPromotionIds: [8] },
      { productId: 56, lineTotal: 10, discount: 1, appliedPromotionIds: [8] },
      { productId: 57, lineTotal: 10, discount: 0, appliedPromotionIds: [] },
    ]);
    expect(priced.appliedPromotions).toEqual([{ id: 8, name: 'Brand and Product 10%', badgeLabel: '-10%', savings: 2 }]);
  });
});

// ---- Conflicts and stacking ---------------------------------------------------------------------------------

test('TC-PROMO-3-08 of two non-stackable matches only the one that saves more is applied', async ({ request }) => {
  await test.step('Create and publish promotion 8 (30%, priority 1, Type 3)', async () => {
    expect(await createAndPublish(request, { name: 'Hiking 30%', value: 30, priority: 1, targets: [{ scope: 'Type', targetId: 3 }] })).toBe(8);
  });
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 12, 89.99 x 1', async () => {
    priced = await ok(await evaluateItems(request, [hiking()]));
  });
  await test.step('200 with only promotion 8 applied (27.00)', async () => {
    expect(priced.lines).toEqual([{ productId: 12, lineTotal: 89.99, discount: 27, appliedPromotionIds: [8] }]);
    expect(priced.appliedPromotions).toEqual([{ id: 8, name: 'Hiking 30%', badgeLabel: '-30%', savings: 27 }]);
    totals(priced, 89.99, 27, 62.99);
  });
});

test('TC-PROMO-3-09 two non-stackable matches that save the same amount: the higher Priority is applied', async ({ request }) => {
  await test.step('Create and publish promotion 8 (20%, priority 20, Type 3)', async () => {
    expect(await createAndPublish(request, { name: 'Hiking 20% priority 20', value: 20, priority: 20, targets: [{ scope: 'Type', targetId: 3 }] })).toBe(8);
  });
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 12, 89.99 x 1', async () => {
    priced = await ok(await evaluateItems(request, [hiking()]));
  });
  await test.step('200 with only promotion 8 applied (18.00)', async () => {
    expect(priced.lines).toEqual([{ productId: 12, lineTotal: 89.99, discount: 18, appliedPromotionIds: [8] }]);
    expect(priced.appliedPromotions).toEqual([{ id: 8, name: 'Hiking 20% priority 20', badgeLabel: '-20%', savings: 18 }]);
  });
});

test('TC-PROMO-3-10 equal saving and equal Priority: the lower Id is applied', async ({ request }) => {
  await test.step('Create and publish promotion 8 (20%, priority 10, Type 3)', async () => {
    expect(await createAndPublish(request, { name: 'Hiking 20% twin', value: 20, priority: 10, targets: [{ scope: 'Type', targetId: 3 }] })).toBe(8);
  });
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 12, 89.99 x 1', async () => {
    priced = await ok(await evaluateItems(request, [hiking()]));
  });
  await test.step('200 with only promotion 1 applied (18.00)', async () => {
    expect(priced.lines).toEqual([{ productId: 12, lineTotal: 89.99, discount: 18, appliedPromotionIds: [1] }]);
    expect(priced.appliedPromotions).toEqual([{ id: 1, name: 'Fall Hiking Sale', badgeLabel: '-20%', savings: 18 }]);
  });
});

test('TC-PROMO-3-11 a BuyXGetY that saves more beats a PercentOff on the same line', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 40 in type 3, 15.00 x 3', async () => {
    priced = await ok(await evaluateItems(request, [line(40, 3, 5, 15, 3)]));
  });
  await test.step('200 with only promotion 2 applied (15.00, not 9.00 from promotion 1)', async () => {
    expect(priced.lines).toEqual([{ productId: 40, lineTotal: 45, discount: 15, appliedPromotionIds: [2] }]);
    expect(priced.appliedPromotions).toEqual([{ id: 2, name: 'Buy 2 Get 1 Free', badgeLabel: 'Buy 2 Get 1', savings: 15 }]);
  });
});

test('TC-PROMO-3-12 a stackable percentage is applied to the amount left after the winning non-stackable discount', async ({ request }) => {
  await test.step('Create and publish promotion 8 (stackable 10%, priority 5, Type 3)', async () => {
    expect(await createAndPublish(request, { name: 'Extra 10% stackable', value: 10, priority: 5, isStackable: true, targets: [{ scope: 'Type', targetId: 3 }] })).toBe(8);
  });
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 13 (type 3), 100.00 x 1', async () => {
    priced = await ok(await evaluateItems(request, [line(13, 3, 7, 100)]));
  });
  await test.step('200 with 20.00 from promotion 1 then 10% of 80.00 = 8.00 from promotion 8', async () => {
    expect(priced.lines).toEqual([{ productId: 13, lineTotal: 100, discount: 28, appliedPromotionIds: [1, 8] }]);
    expect(priced.appliedPromotions).toEqual([
      { id: 1, name: 'Fall Hiking Sale', badgeLabel: '-20%', savings: 20 },
      { id: 8, name: 'Extra 10% stackable', badgeLabel: '-10%', savings: 8 },
    ]);
    totals(priced, 100, 28, 72);
  });
});

test("TC-PROMO-3-13 a line's discount is capped at its total", async ({ request }) => {
  await test.step('Create and publish promotion 8 ($10 off over 1)', async () => {
    expect(await createAndPublish(request, { name: 'Ten off over 1', type: 'AmountOffOrder', value: 10, minOrderTotal: 1, targets: [{ scope: 'All' }] })).toBe(8);
  });
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 99, 5.00 x 1', async () => {
    priced = await ok(await evaluateItems(request, [line(99, 9, 9, 5)]));
  });
  await test.step('200 with the line at 0.00: discount 5.00, not 10.00', async () => {
    expect(priced.lines).toEqual([{ productId: 99, lineTotal: 5, discount: 5, appliedPromotionIds: [8] }]);
    totals(priced, 5, 5, 0);
    expect(priced.appliedPromotions).toHaveLength(1);
    expect(priced.appliedPromotions[0]).toMatchObject({ id: 8, savings: 5 });
  });
});

// ---- Order level --------------------------------------------------------------------------------------------

test('TC-PROMO-3-14 order-level $10 is split across lines by remaining total and adds up to exactly 10.00', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 12 (89.99) and product 99 (90.00)', async () => {
    priced = await ok(await evaluateItems(request, [hiking(), line(99, 9, 9, 90)]));
  });
  await test.step('200 with 4.44 and 5.56 as the order-level parts', async () => {
    totals(priced, 179.99, 28, 151.99);
    expect(priced.lines).toEqual([
      { productId: 12, lineTotal: 89.99, discount: 22.44, appliedPromotionIds: [1, 3] },
      { productId: 99, lineTotal: 90, discount: 5.56, appliedPromotionIds: [3] },
    ]);
    expect(Math.round((22.44 - 18 + 5.56) * 100)).toBe(1000);
    expect(priced.appliedPromotions).toEqual([
      { id: 1, name: 'Fall Hiking Sale', badgeLabel: '-20%', savings: 18 },
      { id: 3, name: '$10 off orders over $150', badgeLabel: '$10 off', savings: 10 },
    ]);
    expect(priced.nextThreshold).toBeNull();
  });
});

test('TC-PROMO-3-15 at exactly the 150.00 threshold the rounding remainder of the split goes to the largest line', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with 70.00, 40.00 and 40.00 lines', async () => {
    priced = await ok(await evaluateItems(request, [line(99, 9, 9, 70), line(98, 8, 8, 40), line(97, 7, 7, 40)]));
  });
  await test.step('200 with discounts 4.66, 2.67 and 2.67 adding up to 10.00', async () => {
    totals(priced, 150, 10, 140);
    expect(priced.lines).toEqual([
      { productId: 99, lineTotal: 70, discount: 4.66, appliedPromotionIds: [3] },
      { productId: 98, lineTotal: 40, discount: 2.67, appliedPromotionIds: [3] },
      { productId: 97, lineTotal: 40, discount: 2.67, appliedPromotionIds: [3] },
    ]);
    expect(Math.round(priced.lines.reduce((sum, l) => sum + l.discount, 0) * 100)).toBe(1000);
    expect(priced.nextThreshold).toBeNull();
  });
});

test('TC-PROMO-3-16 a subtotal of 149.99 does not get the order-level discount', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 99, 149.99 x 1', async () => {
    priced = await ok(await evaluateItems(request, [line(99, 9, 9, 149.99)]));
  });
  await test.step('200 with no discount and 0.01 remaining to the threshold', async () => {
    totals(priced, 149.99, 0, 149.99);
    expect(priced.lines).toEqual([{ productId: 99, lineTotal: 149.99, discount: 0, appliedPromotionIds: [] }]);
    expect(priced.appliedPromotions).toEqual([]);
    expect(priced.nextThreshold).toEqual(NEXT_THRESHOLD_3(0.01));
  });
});

test('TC-PROMO-3-17 nextThreshold.amountRemaining is measured after line discounts', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 12 (89.99) and product 99 (70.00)', async () => {
    priced = await ok(await evaluateItems(request, [hiking(), line(99, 9, 9, 70)]));
  });
  await test.step('200 with 8.01 remaining (150 - 141.99) and promotion 3 not applied', async () => {
    totals(priced, 159.99, 18, 141.99);
    expect(priced.lines.flatMap((l) => l.appliedPromotionIds)).not.toContain(3);
    expect(priced.appliedPromotions.map((p) => p.id)).toEqual([1]);
    expect(priced.nextThreshold).toEqual(NEXT_THRESHOLD_3(8.01));
  });
});

test('TC-PROMO-3-18 nextThreshold is the unmet AmountOffOrder with the smallest amount remaining', async ({ request }) => {
  await test.step('Create and publish promotion 8 ($5 off over 100)', async () => {
    expect(await createAndPublish(request, { name: 'Five off over 100', type: 'AmountOffOrder', value: 5, minOrderTotal: 100, targets: [{ scope: 'All' }] })).toBe(8);
  });
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 99, 20.00 x 2', async () => {
    priced = await ok(await evaluateItems(request, [line(99, 9, 9, 20, 2)]));
  });
  await test.step('200 with promotion 8 (60.00 remaining) as the next threshold, not promotion 3 (110.00)', async () => {
    totals(priced, 40, 0, 40);
    expect(priced.nextThreshold).toEqual({ promotionId: 8, minOrderTotal: 100, amountRemaining: 60, reward: 5 });
  });
});

test('TC-PROMO-3-19 when two AmountOffOrder promotions are met only the best one is applied', async ({ request }) => {
  await test.step('Create and publish promotion 8 ($15 off over 100)', async () => {
    expect(await createAndPublish(request, { name: 'Fifteen off over 100', type: 'AmountOffOrder', value: 15, minOrderTotal: 100, targets: [{ scope: 'All' }] })).toBe(8);
  });
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 99 (100.00) and product 98 (60.00)', async () => {
    priced = await ok(await evaluateItems(request, [line(99, 9, 9, 100), line(98, 8, 8, 60)]));
  });
  await test.step('200 with only promotion 8 applied: 9.38 and 5.62', async () => {
    totals(priced, 160, 15, 145);
    expect(priced.lines).toEqual([
      { productId: 99, lineTotal: 100, discount: 9.38, appliedPromotionIds: [8] },
      { productId: 98, lineTotal: 60, discount: 5.62, appliedPromotionIds: [8] },
    ]);
    expect(priced.appliedPromotions).toHaveLength(1);
    expect(priced.appliedPromotions[0]).toMatchObject({ id: 8, savings: 15 });
    expect(priced.nextThreshold).toBeNull();
  });
});

test("TC-PROMO-3-20 line discounts are rounded to 2 decimals with banker's rounding", async ({ request }) => {
  await test.step('Create and publish promotion 8 (5% on Type 6)', async () => {
    expect(await createAndPublish(request, { name: 'Five percent type 6', value: 5, priority: 1, targets: [{ scope: 'Type', targetId: 6 }] })).toBe(8);
  });
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 61 (10.50) and product 62 (10.70)', async () => {
    priced = await ok(await evaluateItems(request, [line(61, 6, 1, 10.5), line(62, 6, 1, 10.7)]));
  });
  await test.step('200 with 0.525 -> 0.52 and 0.535 -> 0.54', async () => {
    expect(priced.lines.map((l) => l.discount)).toEqual([0.52, 0.54]);
    totals(priced, 21.2, 1.06, 20.14);
  });
});

// ---- Which promotions are candidates ------------------------------------------------------------------------

/** One line of product 99 at 100.00 gets nothing from a seed promotion that is not Active. */
async function expectNotApplied(request: APIRequestContext, promotion: number) {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 99, 100.00 x 1', async () => {
    priced = await ok(await evaluateItems(request, [line(99, 9, 9, 100)]));
  });
  await test.step(`200 with no discount and promotion ${promotion} not listed`, async () => {
    totals(priced, 100, 0, 100);
    expect(priced.lines).toEqual([{ productId: 99, lineTotal: 100, discount: 0, appliedPromotionIds: [] }]);
    expect(priced.appliedPromotions).toEqual([]);
  });
}

test('TC-PROMO-3-21 a Draft promotion is never applied', async ({ request }) => {
  await expectNotApplied(request, 5);
});

test('TC-PROMO-3-22 a promotion that has ended is never applied', async ({ request }) => {
  await expectNotApplied(request, 6);
});

test('TC-PROMO-3-23 a promotion that has not started yet is never applied', async ({ request }) => {
  await expectNotApplied(request, 7);
});

test('TC-PROMO-3-24 a promotion ended by an admin stops applying at once, inside the 30 second cache window', async ({ request }) => {
  let first!: Priced;
  await test.step('POST /api/promotions/evaluate with product 12, 89.99 x 1 (fills the cache)', async () => {
    first = await ok(await evaluateItems(request, [hiking()]));
    expect(first.lines).toEqual([{ productId: 12, lineTotal: 89.99, discount: 18, appliedPromotionIds: [1] }]);
  });
  await test.step('POST /api/promotions/1/end with the admin token: 204', async () => {
    const response = await request.post(`${API}/1/end?${V}`, { headers: bearer(adminToken) });
    expect(response.status(), await response.text()).toBe(204);
  });
  await test.step('Repeat the evaluate request at once: promotion 1 no longer applies', async () => {
    const second = await ok(await evaluateItems(request, [hiking()]));
    totals(second, 89.99, 0, 89.99);
    expect(second.lines).toEqual([{ productId: 12, lineTotal: 89.99, discount: 0, appliedPromotionIds: [] }]);
    expect(second.appliedPromotions).toEqual([]);
  });
});

test('TC-PROMO-3-25 a promotion whose EndsAt passes inside the 30 second cache window stops applying', async ({ request }) => {
  let publishedAt = 0;
  await test.step('Create and publish promotion 8 (10% on Type 6, ends in 10 seconds)', async () => {
    expect(await createAndPublish(request, { name: 'Ten percent 10 seconds', value: 10, priority: 1, targets: [{ scope: 'Type', targetId: 6 }], endsAt: at(10 * SECOND) })).toBe(8);
    publishedAt = Date.now();
  });
  await test.step('POST /api/promotions/evaluate with product 61, 100.00 x 1: 10.00 off from promotion 8', async () => {
    const priced = await ok(await evaluateItems(request, [line(61, 6, 1, 100)]));
    expect(priced.lines).toEqual([{ productId: 61, lineTotal: 100, discount: 10, appliedPromotionIds: [8] }]);
  });
  await test.step('Wait until 12 seconds after publishing (inside the 30 second cache time) and repeat', async () => {
    await sleep(Math.max(0, publishedAt + 12 * SECOND - Date.now()));
    expect(Date.now() - publishedAt).toBeLessThan(30 * SECOND);
    const priced = await ok(await evaluateItems(request, [line(61, 6, 1, 100)]));
    totals(priced, 100, 0, 100);
    expect(priced.lines).toEqual([{ productId: 61, lineTotal: 100, discount: 0, appliedPromotionIds: [] }]);
    expect(priced.appliedPromotions).toEqual([]);
  });
});

// ---- Coupon stub and side effects ---------------------------------------------------------------------------

test('TC-PROMO-3-26 a coupon code is accepted and, until PROMO-4, reported as NotProvided without applying coupon-only promotions', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with couponCode FALL10 and product 99, 100.00 x 1', async () => {
    priced = await ok(await evaluate(request, { couponCode: 'FALL10', items: [line(99, 9, 9, 100)] }));
  });
  await test.step('200 with coupon NotProvided (no code, no reason) and promotion 4 not applied', async () => {
    expect(priced.coupon.status).toBe('NotProvided');
    expect(priced.coupon.code).toBeNull();
    expect(priced.coupon.reason ?? null).toBeNull();
    expect(priced.totalDiscount).toBe(0);
    expect(priced.total).toBe(100);
    expect(priced.appliedPromotions).toEqual([]);
  });
});

test('TC-PROMO-3-27 sending the same request twice gives identical responses and changes no data', async ({ request }) => {
  const body = { couponCode: 'FALL10', items: [hiking(), line(40, 1, 5, 15, 3)] };
  let before!: Record<string, number>;
  await test.step('Note the row counts of Promotions, PromotionTargets, Coupons and IntegrationEventLog', async () => {
    before = rowCounts();
  });
  let first = '';
  await test.step('POST /api/promotions/evaluate with the cart and coupon FALL10', async () => {
    const response = await evaluate(request, body);
    expect(response.status()).toBe(200);
    first = await response.text();
  });
  let second = '';
  await test.step('Send exactly the same request again', async () => {
    const response = await evaluate(request, body);
    expect(response.status()).toBe(200);
    second = await response.text();
  });
  await test.step('Both bodies are byte-for-byte equal and the row counts and coupon FALL10 are unchanged', async () => {
    expect(second).toBe(first);
    expect(rowCounts()).toEqual(before);
    expect(promotionsSql(`SELECT "Id", "PromotionId", "Code" FROM "Coupons" WHERE "Code" = 'FALL10'`)).toEqual([{ Id: 1, PromotionId: 4, Code: 'FALL10' }]);
  });
});

// ---- Authentication -----------------------------------------------------------------------------------------

test('TC-PROMO-3-28 evaluate without a token returns 401', async ({ request }) => {
  let response!: APIResponse;
  await test.step('POST /api/promotions/evaluate with no Authorization header', async () => {
    response = await evaluateItems(request, [hiking()], null);
  });
  await test.step('401 and no pricing in the body', async () => {
    expect(response.status()).toBe(401);
    const text = await response.text();
    expect(text).not.toContain('subtotal');
    expect(text).not.toContain('lines');
  });
});

test('TC-PROMO-3-29 any signed-in user, without the admin role, can evaluate a cart', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with the bob token and product 12, 89.99 x 1', async () => {
    priced = await ok(await evaluateItems(request, [hiking()], bobToken));
  });
  await test.step('200 with 18.00 off, the same body as for alice', async () => {
    expect(priced.totalDiscount).toBe(18);
    expect(priced.total).toBe(71.99);
    const alice = await evaluateItems(request, [hiking()], adminToken);
    expect(await alice.json()).toEqual(priced);
  });
});

// ---- Input validation ---------------------------------------------------------------------------------------

test('TC-PROMO-3-30 an empty items array is rejected', async ({ request }) => {
  let response!: APIResponse;
  await test.step('POST /api/promotions/evaluate with items []', async () => {
    response = await evaluate(request, { items: [] });
  });
  await test.step('400 ValidationProblem with an items error', async () => {
    await expectRejected(response, 'items');
  });
});

test('TC-PROMO-3-31 a body without items is rejected', async ({ request }) => {
  let response!: APIResponse;
  await test.step('POST /api/promotions/evaluate with {}', async () => {
    response = await evaluate(request, {});
  });
  await test.step('400 ValidationProblem with an items error', async () => {
    await expectRejected(response, 'items');
  });
});

const manyLines = (count: number) => Array.from({ length: count }, (_, i) => line(1000 + i, 9, 9, 1));

test('TC-PROMO-3-32 101 lines are rejected', async ({ request }) => {
  let response!: APIResponse;
  await test.step('POST /api/promotions/evaluate with 101 lines (products 1000 to 1100)', async () => {
    response = await evaluateItems(request, manyLines(101));
  });
  await test.step('400 ValidationProblem with an items error', async () => {
    await expectRejected(response, 'items');
  });
});

test('TC-PROMO-3-33 exactly 100 lines are accepted', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with 100 lines (products 1000 to 1099)', async () => {
    priced = await ok(await evaluateItems(request, manyLines(100)));
  });
  await test.step('200 with 100 lines in request order and 50.00 remaining to the threshold', async () => {
    totals(priced, 100, 0, 100);
    expect(priced.lines.map((l) => l.productId)).toEqual(Array.from({ length: 100 }, (_, i) => 1000 + i));
    expect(priced.nextThreshold).toEqual(NEXT_THRESHOLD_3(50));
  });
});

test('TC-PROMO-3-34 two lines with the same productId are rejected', async ({ request }) => {
  let response!: APIResponse;
  await test.step('POST /api/promotions/evaluate with two lines for product 12', async () => {
    response = await evaluateItems(request, [hiking(), line(12, 3, 2, 89.99, 2)]);
  });
  await test.step('400 ValidationProblem with an items[1].productId error', async () => {
    await expectRejected(response, 'items[1].productId');
  });
});

test('TC-PROMO-3-35 a negative unitPrice is rejected', async ({ request }) => {
  let response!: APIResponse;
  await test.step('POST /api/promotions/evaluate with unitPrice -0.01', async () => {
    response = await evaluateItems(request, [line(99, 9, 9, -0.01)]);
  });
  await test.step('400 ValidationProblem with an items[0].unitPrice error', async () => {
    await expectRejected(response, 'items[0].unitPrice');
  });
});

test('TC-PROMO-3-36 a unitPrice of 0 is accepted', async ({ request }) => {
  let priced!: Priced;
  await test.step('POST /api/promotions/evaluate with product 99, unitPrice 0.00', async () => {
    priced = await ok(await evaluateItems(request, [line(99, 9, 9, 0)]));
  });
  await test.step('200 with everything at 0.00', async () => {
    totals(priced, 0, 0, 0);
    expect(priced.lines).toEqual([{ productId: 99, lineTotal: 0, discount: 0, appliedPromotionIds: [] }]);
  });
});

test('TC-PROMO-3-37 a quantity of 0 is rejected', async ({ request }) => {
  let response!: APIResponse;
  await test.step('POST /api/promotions/evaluate with quantity 0', async () => {
    response = await evaluateItems(request, [line(99, 9, 9, 20, 0)]);
  });
  await test.step('400 ValidationProblem with an items[0].quantity error', async () => {
    await expectRejected(response, 'items[0].quantity');
  });
});
