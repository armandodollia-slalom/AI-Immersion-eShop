/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect } from '../fixtures';
import { DOCKER, loadScenario } from './scenario';
import { getTokens } from './auth-basket-helpers';
import { SLOT, port } from './ports';

// PROMO-2: tests/plans/PROMO-2-promotion-rule-model-and-admin-api. The admin API, the public /active feed and the
// lifecycle events, against the Promotions.API container of the test stack (its real 30 s lifecycle worker, real
// Postgres, tokens issued by the real Identity.API). Scenario: testing/scenarios/promo-2 (promo-1 with the start events
// of promotions 1-4 recorded as sent): 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 ended yesterday,
// 7 starts tomorrow. The database is reset before every case.
const PROMOTIONS_URL = `http://localhost:${port('promotions')}`;
const API = `${PROMOTIONS_URL}/api/promotions`;
const V = 'api-version=1.0';
const ACTIVE = `${API}/active?${V}`;

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const STARTED = 'PromotionStartedIntegrationEvent';
const ENDED = 'PromotionEndedIntegrationEvent';

let adminToken = '';
let bobToken = '';
let noScopeToken = '';

test.beforeEach(() => {
  loadScenario('promo-2');
});

test.beforeAll(async () => {
  loadScenario('promo-2');
  adminToken = (await getTokens('alice', 'Pass123$', 'openid profile promotions')).access_token;
  bobToken = (await getTokens('bob', 'Pass123$', 'openid profile promotions')).access_token;
  noScopeToken = (await getTokens('alice', 'Pass123$', 'openid profile')).access_token;
});

// ---- helpers -----------------------------------------------------------------------------------------------

const stackProject = () => (SLOT === 0 ? 'eshop-teststack' : `eshop-teststack-${SLOT}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const adminHeaders = () => bearer(adminToken);

/** Body V of the plan: a valid PercentOff promotion for Type 3, starting in a day. Properties set to undefined are left out. */
function bodyV(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Fall Hiking Sale',
    description: '20% off all hiking gear',
    type: 'PercentOff',
    value: 20,
    targets: [{ scope: 'Type', targetId: 3 }],
    startsAt: at(DAY),
    endsAt: at(8 * DAY),
    priority: 10,
    isStackable: false,
    requiresCoupon: false,
    ...change,
  };
}

/** Body U of the plan: V with another name and value. */
const bodyU = (change: Record<string, unknown> = {}) => bodyV({ name: 'Fall Hiking Sale v2', value: 25, ...change });

/** Body V with a start in the past (already started when published). */
const startedBody = (change: Record<string, unknown> = {}) => bodyV({ startsAt: at(-HOUR), endsAt: at(7 * DAY), ...change });

const create = (request: APIRequestContext, body: Record<string, unknown>, headers: Record<string, string> = adminHeaders()) =>
  request.post(`${API}?${V}`, { headers, data: body });
const get = (request: APIRequestContext, id: number, headers: Record<string, string> = adminHeaders()) =>
  request.get(`${API}/${id}?${V}`, { headers });
const put = (request: APIRequestContext, id: number, body: Record<string, unknown>, headers: Record<string, string> = adminHeaders()) =>
  request.put(`${API}/${id}?${V}`, { headers, data: body });
const publish = (request: APIRequestContext, id: number, headers: Record<string, string> = adminHeaders()) =>
  request.post(`${API}/${id}/publish?${V}`, { headers });
const end = (request: APIRequestContext, id: number, headers: Record<string, string> = adminHeaders()) =>
  request.post(`${API}/${id}/end?${V}`, { headers });
const list = (request: APIRequestContext, query: string, headers: Record<string, string> = adminHeaders()) =>
  request.get(`${API}?${query ? `${query}&` : ''}${V}`, { headers });

async function createDraft(request: APIRequestContext, body: Record<string, unknown> = bodyV()): Promise<number> {
  const response = await create(request, body);
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).id;
}

async function createPublished(request: APIRequestContext, body: Record<string, unknown>): Promise<{ id: number; published: any }> {
  const id = await createDraft(request, body);
  const response = await publish(request, id);
  expect(response.status(), await response.text()).toBe(200);
  return { id, published: await response.json() };
}

const activeIds = async (request: APIRequestContext, headers: Record<string, string> = {}): Promise<number[]> => {
  const response = await request.get(ACTIVE, { headers });
  expect(response.status()).toBe(200);
  return (await response.json()).map((p: { id: number }) => p.id);
};

async function promotionCount(request: APIRequestContext): Promise<number> {
  const response = await list(request, 'page=0&pageSize=100');
  expect(response.status()).toBe(200);
  return (await response.json()).data.length;
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

interface EventRow { EventTypeName: string; State: number; TimesSent: number; CreationTime: string; Content: string }

/** Outbox rows of one event type about one promotion (the event content carries its PromotionId). */
const eventRows = (type: string, promotionId: number): EventRow[] =>
  promotionsSql<EventRow>(
    `SELECT "EventTypeName", "State", "TimesSent", "CreationTime", "Content" FROM "IntegrationEventLog"
     WHERE "EventTypeName" LIKE '%${type}' AND ("Content"::jsonb ->> 'PromotionId') = '${promotionId}' ORDER BY "CreationTime"`,
  );
const eventCount = (type: string, promotionId: number) => eventRows(type, promotionId).length;
const anyEventCount = (promotionId: number) =>
  promotionsSql<{ n: number }>(`SELECT count(*)::int AS n FROM "IntegrationEventLog" WHERE ("Content"::jsonb ->> 'PromotionId') = '${promotionId}'`)[0].n;
const eventLogCount = () => promotionsSql<{ n: number }>('SELECT count(*)::int AS n FROM "IntegrationEventLog"')[0].n;

/** Check that the number of event rows stays at `expected` for `durationMs`, sampled every `intervalMs`. */
async function expectEventCountFor(type: string, id: number, expected: number, durationMs: number, intervalMs = 5 * SECOND) {
  const stop = Date.now() + durationMs;
  do {
    expect(eventCount(type, id)).toBe(expected);
    await sleep(Math.min(intervalMs, Math.max(0, stop - Date.now())));
  } while (Date.now() < stop);
  expect(eventCount(type, id)).toBe(expected);
}

const sameInstant = (actual: string, expected: string) => expect(new Date(actual).getTime()).toBe(new Date(expected).getTime());

/** POST a body that must be rejected: 400 naming exactly `keys`, nothing saved and no Location header. */
async function expectRejected(request: APIRequestContext, body: Record<string, unknown>, keys: string[]) {
  let before = 0;
  await test.step('GET /api/promotions?page=0&pageSize=100 and note the total count', async () => {
    before = await promotionCount(request);
  });

  let response!: APIResponse;
  await test.step('POST /api/promotions with the admin token and the invalid body', async () => {
    response = await create(request, body);
  });

  await test.step('400 ValidationProblem whose errors name exactly the failing fields', async () => {
    expect(response.status()).toBe(400);
    const problem = await response.json();
    expect(Object.keys(problem.errors).sort()).toEqual([...keys].sort());
    expect(response.headers()['location']).toBeUndefined();
  });

  await test.step('GET /api/promotions?page=0&pageSize=100 again: same total count', async () => {
    expect(await promotionCount(request)).toBe(before);
  });
}

// ---- Create ------------------------------------------------------------------------------------------------

test('TC-PROMO-2-01 valid promotion is created as Draft with 201, Location and the full body', async ({ request }) => {
  let logBefore = 0;
  const body = bodyV();
  await test.step('Note the row count of IntegrationEventLog', async () => {
    logBefore = eventLogCount();
  });

  let response!: APIResponse;
  await test.step('POST /api/promotions with the admin token and body V', async () => {
    response = await create(request, body);
  });

  await test.step('201 with Location /api/promotions/{id} (id > 7) and the full body', async () => {
    expect(response.status()).toBe(201);
    const created = await response.json();
    expect(created.id).toBeGreaterThan(7);
    expect(new URL(response.headers()['location'], PROMOTIONS_URL).pathname).toBe(`/api/promotions/${created.id}`);
    expect(created).toMatchObject({
      name: 'Fall Hiking Sale',
      description: '20% off all hiking gear',
      type: 'PercentOff',
      value: 20,
      targets: [{ scope: 'Type', targetId: 3 }],
      priority: 10,
      isStackable: false,
      requiresCoupon: false,
      status: 'Draft',
      effectiveStatus: 'Draft',
    });
    expect(created.targets).toHaveLength(1);
    sameInstant(created.startsAt, body.startsAt as string);
    sameInstant(created.endsAt, body.endsAt as string);
  });

  await test.step('IntegrationEventLog has the same row count (no event published)', async () => {
    expect(eventLogCount()).toBe(logBefore);
  });
});

test('TC-PROMO-2-02 omitted priority, isStackable and requiresCoupon default to 0, false, false', async ({ request }) => {
  const body = bodyV({ priority: undefined, isStackable: undefined, requiresCoupon: undefined });
  let created: any;
  await test.step('POST /api/promotions with the admin token and the body without the three fields', async () => {
    const response = await create(request, body);
    expect(response.status()).toBe(201);
    created = await response.json();
  });

  await test.step('GET /api/promotions/{id} with the admin token', async () => {
    const response = await get(request, created.id);
    expect(response.status()).toBe(200);
    for (const promotion of [created, await response.json()]) {
      expect(promotion.priority).toBe(0);
      expect(promotion.isStackable).toBe(false);
      expect(promotion.requiresCoupon).toBe(false);
    }
  });
});

test('TC-PROMO-2-03 a status sent in the create body is ignored and the promotion is saved as Draft', async ({ request }) => {
  let created: any;
  await test.step('POST /api/promotions with the admin token and body V plus "status": "Published"', async () => {
    const response = await create(request, bodyV({ status: 'Published' }));
    expect(response.status()).toBe(201);
    created = await response.json();
  });

  await test.step('The body has status Draft and effectiveStatus Draft', async () => {
    expect(created.status).toBe('Draft');
    expect(created.effectiveStatus).toBe('Draft');
  });

  await test.step('GET /api/promotions/active anonymously does not list the new id', async () => {
    expect(await activeIds(request)).not.toContain(created.id);
  });
});

test('TC-PROMO-2-04 a target with scope All and null targetId is accepted', async ({ request }) => {
  const response = await test.step('POST /api/promotions with targets [{All, null}]', () =>
    create(request, bodyV({ targets: [{ scope: 'All', targetId: null }] })));

  await test.step('201 and exactly one target {All, null}', async () => {
    expect(response.status()).toBe(201);
    expect((await response.json()).targets).toEqual([{ scope: 'All', targetId: null }]);
  });
});

test('TC-PROMO-2-05 several targets of different scopes are all stored and returned', async ({ request }) => {
  const targets = [{ scope: 'Brand', targetId: 2 }, { scope: 'Type', targetId: 3 }, { scope: 'Product', targetId: 40 }];
  let created: any;
  await test.step('POST /api/promotions with targets Brand 2, Type 3, Product 40', async () => {
    const response = await create(request, bodyV({ targets }));
    expect(response.status()).toBe(201);
    created = await response.json();
  });

  await test.step('GET /api/promotions/{id}', async () => {
    const response = await get(request, created.id);
    expect(response.status()).toBe(200);
    expect((await response.json()).targets).toEqual(targets);
  });

  await test.step('Both responses list exactly the three targets', async () => {
    expect(created.targets).toEqual(targets);
  });
});

test('TC-PROMO-2-06 PercentOff value 100 is accepted', async ({ request }) => {
  const response = await test.step('POST /api/promotions with value 100', () => create(request, bodyV({ value: 100 })));

  await test.step('201 and value 100', async () => {
    expect(response.status()).toBe(201);
    expect((await response.json()).value).toBe(100);
  });
});

test('TC-PROMO-2-07 valid BuyXGetY ignores value and keeps both quantities', async ({ request }) => {
  const response = await test.step('POST /api/promotions with BuyXGetY, value 55, buyQuantity 2, getQuantity 1', () =>
    create(request, bodyV({ type: 'BuyXGetY', value: 55, buyQuantity: 2, getQuantity: 1 })));

  await test.step('201 with type BuyXGetY, buyQuantity 2 and getQuantity 1 and no error for value', async () => {
    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({ type: 'BuyXGetY', buyQuantity: 2, getQuantity: 1 });
  });
});

test('TC-PROMO-2-08 valid AmountOffOrder with minOrderTotal is accepted', async ({ request }) => {
  const response = await test.step('POST /api/promotions with AmountOffOrder, value 10, minOrderTotal 150', () =>
    create(request, bodyV({ type: 'AmountOffOrder', value: 10, minOrderTotal: 150 })));

  await test.step('201 with type AmountOffOrder, value 10 and minOrderTotal 150', async () => {
    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({ type: 'AmountOffOrder', value: 10, minOrderTotal: 150 });
  });
});

test('TC-PROMO-2-09 name of exactly 100 characters is accepted', async ({ request }) => {
  const response = await test.step('POST /api/promotions with a name of 100 "a"', () => create(request, bodyV({ name: 'a'.repeat(100) })));

  await test.step('201 and the returned name has 100 characters', async () => {
    expect(response.status()).toBe(201);
    expect((await response.json()).name).toHaveLength(100);
  });
});

test('TC-PROMO-2-10 description of exactly 500 characters is accepted', async ({ request }) => {
  const response = await test.step('POST /api/promotions with a description of 500 "a"', () =>
    create(request, bodyV({ description: 'a'.repeat(500) })));

  await test.step('201 and the returned description has 500 characters', async () => {
    expect(response.status()).toBe(201);
    expect((await response.json()).description).toHaveLength(500);
  });
});

test('TC-PROMO-2-11 endsAt equal to startsAt is rejected', async ({ request }) => {
  const startsAt = at(DAY);
  await expectRejected(request, bodyV({ startsAt, endsAt: startsAt }), ['endsAt']);
});

test('TC-PROMO-2-12 endsAt before startsAt is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ startsAt: at(DAY), endsAt: at(0) }), ['endsAt']);
});

test('TC-PROMO-2-13 PercentOff value 0 is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ value: 0 }), ['value']);
});

test('TC-PROMO-2-14 PercentOff value 100.01 is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ value: 100.01 }), ['value']);
});

test('TC-PROMO-2-15 PercentOff negative value is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ value: -5 }), ['value']);
});

test('TC-PROMO-2-16 AmountOffOrder without minOrderTotal is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ type: 'AmountOffOrder', value: 10 }), ['minOrderTotal']);
});

test('TC-PROMO-2-17 AmountOffOrder value 0 is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ type: 'AmountOffOrder', value: 0, minOrderTotal: 150 }), ['value']);
});

test('TC-PROMO-2-18 BuyXGetY without getQuantity is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ type: 'BuyXGetY', buyQuantity: 2 }), ['getQuantity']);
});

test('TC-PROMO-2-19 BuyXGetY without buyQuantity is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ type: 'BuyXGetY', getQuantity: 1 }), ['buyQuantity']);
});

test('TC-PROMO-2-20 BuyXGetY with buyQuantity 0 is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ type: 'BuyXGetY', buyQuantity: 0, getQuantity: 1 }), ['buyQuantity']);
});

test('TC-PROMO-2-21 empty targets array is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ targets: [] }), ['targets']);
});

test('TC-PROMO-2-22 Brand target without targetId is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ targets: [{ scope: 'Brand', targetId: null }] }), ['targets']);
});

test('TC-PROMO-2-23 All target with a targetId is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ targets: [{ scope: 'All', targetId: 5 }] }), ['targets']);
});

test('TC-PROMO-2-24 missing name is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ name: undefined }), ['name']);
});

test('TC-PROMO-2-25 name of 101 characters is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ name: 'a'.repeat(101) }), ['name']);
});

test('TC-PROMO-2-26 missing description is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ description: undefined }), ['description']);
});

test('TC-PROMO-2-27 description of 501 characters is rejected', async ({ request }) => {
  await expectRejected(request, bodyV({ description: 'a'.repeat(501) }), ['description']);
});

test('TC-PROMO-2-28 several invalid fields are all reported in one 400 and nothing is saved', async ({ request }) => {
  const startsAt = at(DAY);
  await expectRejected(request, bodyV({ name: undefined, value: 0, targets: [], startsAt, endsAt: startsAt }), ['endsAt', 'value', 'targets', 'name']);
});

// ---- Get and list ------------------------------------------------------------------------------------------

test('TC-PROMO-2-29 admin gets one promotion with status and effectiveStatus', async ({ request }) => {
  await test.step('GET /api/promotions/1 with the admin token', async () => {
    const response = await get(request, 1);
    expect(response.status()).toBe(200);
    const promotion = await response.json();
    expect(promotion).toMatchObject({
      id: 1,
      name: 'Fall Hiking Sale',
      type: 'PercentOff',
      value: 20,
      status: 'Published',
      effectiveStatus: 'Active',
      targets: [{ scope: 'Type', targetId: 3 }],
    });
    expect(promotion.targets).toHaveLength(1);
  });

  await test.step('GET /api/promotions/5 with the admin token', async () => {
    const response = await get(request, 5);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'Draft', effectiveStatus: 'Draft' });
  });
});

test('TC-PROMO-2-30 GET of an unknown id returns 404', async ({ request }) => {
  const response = await test.step('GET /api/promotions/99999 with the admin token', () => get(request, 99999));

  await test.step('404', async () => {
    expect(response.status()).toBe(404);
  });
});

async function expectFilter(request: APIRequestContext, status: string, ids: number[]) {
  const response = await test.step(`GET /api/promotions?status=${status}&page=0&pageSize=20 with the admin token`, () =>
    list(request, `status=${status}&page=0&pageSize=20`));

  await test.step(`200 with exactly the ids ${ids.join(', ')}, all with effectiveStatus ${status}`, async () => {
    expect(response.status()).toBe(200);
    const items = (await response.json()).data;
    expect(items.map((p: { id: number }) => p.id).sort((a: number, b: number) => a - b)).toEqual(ids);
    for (const item of items) expect(item.effectiveStatus).toBe(status);
  });
}

test('TC-PROMO-2-31 list filtered by status=Active returns only Active promotions', async ({ request }) => {
  await expectFilter(request, 'Active', [1, 2, 3, 4]);
});

test('TC-PROMO-2-32 list filtered by status=Scheduled returns only Scheduled promotions', async ({ request }) => {
  await expectFilter(request, 'Scheduled', [7]);
});

test('TC-PROMO-2-33 list filtered by status=Expired returns only Expired promotions', async ({ request }) => {
  await expectFilter(request, 'Expired', [6]);
});

test('TC-PROMO-2-34 list filtered by status=Draft returns only Draft promotions', async ({ request }) => {
  await expectFilter(request, 'Draft', [5]);
});

test('TC-PROMO-2-35 paging splits the promotions into pages of the requested size', async ({ request }) => {
  const pages: number[][] = [];
  for (const page of [0, 1, 2]) {
    await test.step(`GET /api/promotions?page=${page}&pageSize=3 with the admin token`, async () => {
      const response = await list(request, `page=${page}&pageSize=3`);
      expect(response.status()).toBe(200);
      pages.push((await response.json()).data.map((p: { id: number }) => p.id));
    });
  }

  await test.step('The pages hold 3, 3 and 1 promotions with the ids 1 to 7 once each', async () => {
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    expect(pages.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

test('TC-PROMO-2-36 a page past the last one returns an empty list', async ({ request }) => {
  const response = await test.step('GET /api/promotions?page=5&pageSize=20 with the admin token', () => list(request, 'page=5&pageSize=20'));

  await test.step('200 with an empty items array', async () => {
    expect(response.status()).toBe(200);
    expect((await response.json()).data).toEqual([]);
  });
});

async function expectListRejected(request: APIRequestContext, query: string, key: string) {
  const response = await test.step(`GET /api/promotions?${query} with the admin token`, () => list(request, query));

  await test.step(`400 ValidationProblem whose errors have the key ${key}`, async () => {
    expect(response.status()).toBe(400);
    expect(Object.keys((await response.json()).errors)).toContain(key);
  });
}

test('TC-PROMO-2-37 unknown status filter returns 400', async ({ request }) => {
  await expectListRejected(request, 'status=Bogus&page=0&pageSize=20', 'status');
});

test('TC-PROMO-2-38 pageSize 0 returns 400', async ({ request }) => {
  await expectListRejected(request, 'page=0&pageSize=0', 'pageSize');
});

test('TC-PROMO-2-39 pageSize 101 returns 400', async ({ request }) => {
  await expectListRejected(request, 'page=0&pageSize=101', 'pageSize');
});

test('TC-PROMO-2-40 negative page returns 400', async ({ request }) => {
  await expectListRejected(request, 'page=-1&pageSize=20', 'page');
});

// ---- Update ------------------------------------------------------------------------------------------------

test('TC-PROMO-2-41 PUT on a Draft promotion updates it and returns 200', async ({ request }) => {
  let id = 0;
  await test.step('Create a Draft with body V', async () => {
    id = await createDraft(request);
  });

  await test.step('PUT /api/promotions/{id} with the admin token and body U', async () => {
    const response = await put(request, id, bodyU());
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'Fall Hiking Sale v2', value: 25, status: 'Draft', effectiveStatus: 'Draft' });
  });

  await test.step('GET /api/promotions/{id} returns the same name and value', async () => {
    const response = await get(request, id);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'Fall Hiking Sale v2', value: 25 });
  });
});

test('TC-PROMO-2-42 PUT on a Scheduled promotion updates it and returns 200', async ({ request }) => {
  const response = await test.step('PUT /api/promotions/7 with body U (startsAt now + 2 days, endsAt now + 9 days)', () =>
    put(request, 7, bodyU({ startsAt: at(2 * DAY), endsAt: at(9 * DAY) })));

  await test.step('200 with the new name, status Published and effectiveStatus Scheduled', async () => {
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'Fall Hiking Sale v2', status: 'Published', effectiveStatus: 'Scheduled' });
  });
});

test('TC-PROMO-2-43 PUT on an Active promotion returns 409 and changes nothing', async ({ request }) => {
  await test.step('PUT /api/promotions/1 with the admin token and body U', async () => {
    expect((await put(request, 1, bodyU())).status()).toBe(409);
  });

  await test.step('GET /api/promotions/1 still shows name Fall Hiking Sale and value 20', async () => {
    const response = await get(request, 1);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'Fall Hiking Sale', value: 20 });
  });
});

test('TC-PROMO-2-44 PUT on an Expired promotion returns 409', async ({ request }) => {
  const response = await test.step('PUT /api/promotions/6 with the admin token and body U', () => put(request, 6, bodyU()));

  await test.step('409', async () => {
    expect(response.status()).toBe(409);
  });
});

test('TC-PROMO-2-45 PUT on a promotion ended through /end returns 409', async ({ request }) => {
  await test.step('POST /api/promotions/2/end with the admin token', async () => {
    expect((await end(request, 2)).status()).toBe(204);
  });

  const response = await test.step('PUT /api/promotions/2 with the admin token and body U', () => put(request, 2, bodyU()));

  await test.step('409', async () => {
    expect(response.status()).toBe(409);
  });
});

test('TC-PROMO-2-46 PUT on an unknown id returns 404', async ({ request }) => {
  const response = await test.step('PUT /api/promotions/99999 with the admin token and body U', () => put(request, 99999, bodyU()));

  await test.step('404', async () => {
    expect(response.status()).toBe(404);
  });
});

test('TC-PROMO-2-47 PUT with an invalid body on a Draft returns 400 and changes nothing', async ({ request }) => {
  let id = 0;
  await test.step('Create a Draft with the valid body V', async () => {
    id = await createDraft(request);
  });

  await test.step('PUT /api/promotions/{id} with the admin token and value 0', async () => {
    const response = await put(request, id, bodyV({ value: 0 }));
    expect(response.status()).toBe(400);
    expect(Object.keys((await response.json()).errors)).toContain('value');
  });

  await test.step('GET /api/promotions/{id} still shows value 20', async () => {
    const response = await get(request, id);
    expect(response.status()).toBe(200);
    expect((await response.json()).value).toBe(20);
  });
});

// ---- Publish -----------------------------------------------------------------------------------------------

test('TC-PROMO-2-48 publishing a Draft that has already started makes it Active and sends the start event once', async ({ request }) => {
  test.setTimeout(240 * SECOND);
  let id = 0;
  await test.step('Create a Draft with startsAt now - 1 hour; no start event exists for it', async () => {
    id = await createDraft(request, startedBody());
    expect(eventCount(STARTED, id)).toBe(0);
  });

  await test.step('POST /api/promotions/{id}/publish with the admin token', async () => {
    const response = await publish(request, id);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'Published', effectiveStatus: 'Active' });
  });

  await test.step('Over 95 seconds (three worker cycles) there is still exactly one PromotionStartedIntegrationEvent row', async () => {
    await expectEventCountFor(STARTED, id, 1, 95 * SECOND);
  });
});

test('TC-PROMO-2-49 publishing a Draft with a future start makes it Scheduled and sends no event yet', async ({ request }) => {
  test.setTimeout(120 * SECOND);
  let id = 0;
  await test.step('Create a Draft with body V (startsAt now + 1 day)', async () => {
    id = await createDraft(request);
  });

  await test.step('POST /api/promotions/{id}/publish with the admin token', async () => {
    const response = await publish(request, id);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'Published', effectiveStatus: 'Scheduled' });
  });

  await test.step('After one worker cycle (35 seconds) there is no PromotionStartedIntegrationEvent row', async () => {
    await expectEventCountFor(STARTED, id, 0, 35 * SECOND);
  });

  await test.step('GET /api/promotions/active anonymously does not include the id', async () => {
    expect(await activeIds(request)).not.toContain(id);
  });
});

test('TC-PROMO-2-50 publish of an unknown id returns 404', async ({ request }) => {
  const response = await test.step('POST /api/promotions/99999/publish with the admin token', () => publish(request, 99999));

  await test.step('404', async () => {
    expect(response.status()).toBe(404);
  });
});

test('TC-PROMO-2-51 a scheduled start event is published within 60s of startsAt', async ({ request }) => {
  test.setTimeout(180 * SECOND);
  const startsAtMs = Date.now() + 10 * SECOND;
  let id = 0;
  await test.step('Create a Draft with startsAt now + 10 seconds and publish it: effectiveStatus Scheduled', async () => {
    id = await createDraft(request, bodyV({ startsAt: new Date(startsAtMs).toISOString(), endsAt: at(DAY) }));
    const response = await publish(request, id);
    expect(response.status()).toBe(200);
    expect((await response.json()).effectiveStatus).toBe('Scheduled');
    expect(eventCount(STARTED, id)).toBe(0);
  });

  await test.step('Poll IntegrationEventLog every 5 seconds until the PromotionStartedIntegrationEvent row appears (at most 70 s after startsAt)', async () => {
    await expect
      .poll(() => eventCount(STARTED, id), { intervals: [5 * SECOND], timeout: startsAtMs + 70 * SECOND - Date.now() })
      .toBe(1);
  });

  await test.step('The single row was created no earlier than startsAt and no later than 60 seconds after it', async () => {
    const [row] = eventRows(STARTED, id);
    const created = new Date(row.CreationTime).getTime();
    expect(created).toBeGreaterThanOrEqual(startsAtMs - SECOND);
    expect(created).toBeLessThanOrEqual(startsAtMs + 60 * SECOND);
  });

  await test.step('GET /api/promotions/{id} shows Active and the promotion is in /active', async () => {
    const response = await get(request, id);
    expect((await response.json()).effectiveStatus).toBe('Active');
    expect(await activeIds(request)).toContain(id);
  });
});

test('TC-PROMO-2-53 the start event carries id, name, description, badge label, end and targets', async ({ request }) => {
  let id = 0;
  const body = startedBody();
  await test.step('Create body V (startsAt now - 1 hour, endsAt now + 7 days, targets [{Type, 3}]) and publish it', async () => {
    id = (await createPublished(request, body)).id;
  });

  await test.step('Read the Content of the PromotionStartedIntegrationEvent row for the id', async () => {
    const rows = eventRows(STARTED, id);
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].Content);
    expect(content.PromotionId).toBe(id);
    expect(content.Name).toBe('Fall Hiking Sale');
    expect(content.Description).toBe('20% off all hiking gear');
    expect(content.BadgeLabel).toBe('-20%');
    sameInstant(content.EndsAt, body.endsAt as string);
    expect(content.Targets).toEqual([{ Scope: 'Type', TargetId: 3 }]);
  });
});

test('TC-PROMO-2-54 outbox entries reach the Published state after sending', async ({ request }) => {
  let id = 0;
  await test.step('Create a started promotion and publish it: the start event row exists', async () => {
    id = (await createPublished(request, startedBody())).id;
    expect(eventCount(STARTED, id)).toBe(1);
  });

  await test.step('Within 10 seconds of the row the State is Published (2) and TimesSent is 1', async () => {
    await expect.poll(() => eventRows(STARTED, id)[0]?.State, { intervals: [SECOND], timeout: 10 * SECOND }).toBe(2);
    expect(eventRows(STARTED, id)[0].TimesSent).toBe(1);
  });
});

test('TC-PROMO-2-67 publish of a non-Draft promotion returns 409 and changes nothing', async ({ request }) => {
  let before: any;
  let eventsBefore = 0;
  await test.step('Note the event rows of promotion 1 and its current state', async () => {
    eventsBefore = anyEventCount(1);
    const response = await get(request, 1);
    expect(response.status()).toBe(200);
    before = await response.json();
  });

  await test.step('POST /api/promotions/1/publish with the admin token returns 409', async () => {
    expect((await publish(request, 1)).status()).toBe(409);
  });

  await test.step('GET /api/promotions/1 is unchanged: Published, Active, same values', async () => {
    const response = await get(request, 1);
    expect(response.status()).toBe(200);
    const after = await response.json();
    expect(after).toMatchObject({ status: 'Published', effectiveStatus: 'Active' });
    expect(after).toEqual(before);
  });

  await test.step('The count of IntegrationEventLog rows for promotion 1 is unchanged', async () => {
    expect(anyEventCount(1)).toBe(eventsBefore);
  });
});

// ---- End ---------------------------------------------------------------------------------------------------

test('TC-PROMO-2-55 end on an Active promotion returns 204, expires it, sends the end event once and removes it from /active', async ({ request }) => {
  test.setTimeout(180 * SECOND);
  let id = 0;
  await test.step('Create a started promotion and publish it', async () => {
    id = (await createPublished(request, startedBody())).id;
    expect(eventCount(STARTED, id)).toBe(1);
  });

  await test.step('GET /api/promotions/active anonymously: the id is present', async () => {
    expect(await activeIds(request)).toContain(id);
  });

  await test.step('POST /api/promotions/{id}/end with the admin token returns 204 with an empty body', async () => {
    const response = await end(request, id);
    expect(response.status()).toBe(204);
    expect(await response.text()).toBe('');
  });

  await test.step('GET /api/promotions/{id} shows effectiveStatus Expired', async () => {
    const response = await get(request, id);
    expect(response.status()).toBe(200);
    expect((await response.json()).effectiveStatus).toBe('Expired');
  });

  await test.step('GET /api/promotions/active anonymously no longer has the id', async () => {
    expect(await activeIds(request)).not.toContain(id);
  });

  await test.step('Over 65 seconds exactly one PromotionEndedIntegrationEvent row exists for the id, with its PromotionId', async () => {
    await expectEventCountFor(ENDED, id, 1, 65 * SECOND);
    expect(JSON.parse(eventRows(ENDED, id)[0].Content).PromotionId).toBe(id);
  });
});

test('TC-PROMO-2-56 an Active promotion that reaches endsAt expires and sends the end event within 60s', async ({ request }) => {
  test.setTimeout(240 * SECOND);
  const endsAtMs = Date.now() + 10 * SECOND;
  let id = 0;
  await test.step('Create body V with startsAt now - 1 hour and endsAt now + 10 seconds and publish it', async () => {
    id = (await createPublished(request, bodyV({ startsAt: at(-HOUR), endsAt: new Date(endsAtMs).toISOString() }))).id;
  });

  await test.step('Poll /active anonymously every 5 seconds for 20 seconds: present before endsAt, gone after it', async () => {
    const samples: { at: number; present: boolean }[] = [];
    for (let i = 0; i < 5; i++) {
      samples.push({ at: Date.now(), present: (await activeIds(request)).includes(id) });
      if (i < 4) await sleep(5 * SECOND);
    }
    expect(samples.some((s) => s.at < endsAtMs - SECOND)).toBe(true);
    expect(samples.some((s) => s.at > endsAtMs + SECOND)).toBe(true);
    for (const s of samples) {
      if (s.at < endsAtMs - SECOND) expect(s.present, `present before endsAt (+${s.at - endsAtMs} ms)`).toBe(true);
      if (s.at > endsAtMs + SECOND) expect(s.present, `gone after endsAt (+${s.at - endsAtMs} ms)`).toBe(false);
    }
  });

  await test.step('Poll IntegrationEventLog every 5 seconds for the PromotionEndedIntegrationEvent row (at most 70 s after endsAt)', async () => {
    await expect
      .poll(() => eventCount(ENDED, id), { intervals: [5 * SECOND], timeout: Math.max(SECOND, endsAtMs + 70 * SECOND - Date.now()) })
      .toBe(1);
    const created = new Date(eventRows(ENDED, id)[0].CreationTime).getTime();
    expect(created).toBeGreaterThanOrEqual(endsAtMs - SECOND);
    expect(created).toBeLessThanOrEqual(endsAtMs + 60 * SECOND);
  });

  await test.step('A further 35 seconds later it is still exactly one end event', async () => {
    await expectEventCountFor(ENDED, id, 1, 35 * SECOND);
  });

  await test.step('GET /api/promotions/{id} shows effectiveStatus Expired', async () => {
    const response = await get(request, id);
    expect((await response.json()).effectiveStatus).toBe('Expired');
  });
});

test('TC-PROMO-2-57 end of an unknown id returns 404', async ({ request }) => {
  const response = await test.step('POST /api/promotions/99999/end with the admin token', () => end(request, 99999));

  await test.step('404', async () => {
    expect(response.status()).toBe(404);
  });
});

// ---- /active -----------------------------------------------------------------------------------------------

test('TC-PROMO-2-58 anonymous /active returns only active, non-coupon promotions', async ({ request }) => {
  const ids = await test.step('GET /api/promotions/active with no token', async () => {
    const response = await request.get(ACTIVE);
    expect(response.status()).toBe(200);
    return (await response.json()).map((p: { id: number }) => p.id);
  });

  await test.step('Exactly the ids 1, 2, 3; ids 4, 5, 6 and 7 are absent', async () => {
    expect([...ids].sort()).toEqual([1, 2, 3]);
    for (const absent of [4, 5, 6, 7]) expect(ids).not.toContain(absent);
  });
});

test('TC-PROMO-2-59 each /active element has the public shape', async ({ request }) => {
  const feed = await test.step('GET /api/promotions/active with no token', async () => {
    const response = await request.get(ACTIVE);
    expect(response.status()).toBe(200);
    return (await response.json()) as any[];
  });

  await test.step('Element 1 has the full public shape with the stored endsAt', async () => {
    const stored = await (await get(request, 1)).json();
    const first = feed.find((p) => p.id === 1);
    expect(first).toMatchObject({
      id: 1,
      name: 'Fall Hiking Sale',
      description: '20% off all hiking gear',
      type: 'PercentOff',
      value: 20,
      badgeLabel: '-20%',
      targets: [{ scope: 'Type', targetId: 3 }],
      priority: 10,
      requiresCoupon: false,
    });
    sameInstant(first.endsAt, stored.endsAt);
  });

  await test.step('Element 2 is BuyXGetY with badge "Buy 2 Get 1"', async () => {
    expect(feed.find((p) => p.id === 2)).toMatchObject({ type: 'BuyXGetY', badgeLabel: 'Buy 2 Get 1' });
  });

  await test.step('Every element has id, name, description, type, value, badgeLabel, targets, endsAt, priority, requiresCoupon', async () => {
    expect(feed.length).toBeGreaterThan(0);
    for (const element of feed) {
      for (const key of ['id', 'name', 'description', 'type', 'value', 'badgeLabel', 'targets', 'endsAt', 'priority', 'requiresCoupon']) {
        expect(Object.keys(element), `element ${element.id} has ${key}`).toContain(key);
      }
    }
  });
});

test('TC-PROMO-2-60 a published coupon-only promotion created through the API is not in /active', async ({ request }) => {
  let id = 0;
  await test.step('Create body V with requiresCoupon true, started an hour ago, and publish it', async () => {
    id = (await createPublished(request, startedBody({ requiresCoupon: true }))).id;
  });

  await test.step('GET /api/promotions/{id} shows effectiveStatus Active and requiresCoupon true', async () => {
    const response = await get(request, id);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ effectiveStatus: 'Active', requiresCoupon: true });
  });

  await test.step('GET /api/promotions/active anonymously does not have the id', async () => {
    expect(await activeIds(request)).not.toContain(id);
  });
});

test('TC-PROMO-2-61 a Draft created through the API is not in /active', async ({ request }) => {
  let id = 0;
  await test.step('Create a Draft with startsAt now - 1 hour', async () => {
    id = await createDraft(request, startedBody());
  });

  await test.step('GET /api/promotions/active anonymously does not have the id', async () => {
    expect(await activeIds(request)).not.toContain(id);
  });
});

// ---- Authorization -----------------------------------------------------------------------------------------

/** The six admin requests of the plan with the given headers. */
function adminRequests(request: APIRequestContext, headers: Record<string, string>) {
  return [
    { step: 'GET /api/promotions?page=0&pageSize=20', send: () => list(request, 'page=0&pageSize=20', headers) },
    { step: 'GET /api/promotions/1', send: () => get(request, 1, headers) },
    { step: 'POST /api/promotions (body V)', send: () => create(request, bodyV(), headers) },
    { step: 'PUT /api/promotions/5 (body V)', send: () => put(request, 5, bodyV(), headers) },
    { step: 'POST /api/promotions/5/publish', send: () => publish(request, 5, headers) },
    { step: 'POST /api/promotions/5/end', send: () => end(request, 5, headers) },
  ];
}

async function expectPromotionsUntouched(request: APIRequestContext) {
  await test.step('Promotion 5 is still a Draft and the promotion count is still 7', async () => {
    expect((await (await get(request, 5)).json()).status).toBe('Draft');
    expect(await promotionCount(request)).toBe(7);
  });
}

test('TC-PROMO-2-62 every admin endpoint returns 401 without a token', async ({ request }) => {
  for (const { step, send } of adminRequests(request, {})) {
    await test.step(`${step} with no Authorization header returns 401`, async () => {
      expect((await send()).status()).toBe(401);
    });
  }

  await expectPromotionsUntouched(request);
});

test('TC-PROMO-2-63 a malformed bearer token returns 401', async ({ request }) => {
  const response = await test.step('GET /api/promotions?page=0&pageSize=20 with Authorization: Bearer not-a-jwt', () =>
    list(request, 'page=0&pageSize=20', bearer('not-a-jwt')));

  await test.step('401', async () => {
    expect(response.status()).toBe(401);
  });
});

test('TC-PROMO-2-64 a token without the admin role is forbidden on every admin endpoint', async ({ request }) => {
  for (const { step, send } of adminRequests(request, bearer(bobToken))) {
    await test.step(`${step} with bob's token (scope promotions, no admin role) returns 403`, async () => {
      expect((await send()).status()).toBe(403);
    });
  }

  await expectPromotionsUntouched(request);
});

test('TC-PROMO-2-65 a token with the admin role but without the promotions scope is rejected', async ({ request }) => {
  const response = await test.step("GET /api/promotions?page=0&pageSize=20 with alice's token without the promotions scope", () =>
    list(request, 'page=0&pageSize=20', bearer(noScopeToken)));

  await test.step('403', async () => {
    expect(response.status()).toBe(403);
  });
});

test('TC-PROMO-2-66 /active stays anonymous even with an invalid token', async ({ request }) => {
  const anonymous = await test.step('GET /api/promotions/active anonymously', () => activeIds(request));

  await test.step('GET /api/promotions/active with Authorization: Bearer not-a-jwt returns 200 and the same ids', async () => {
    const response = await request.get(ACTIVE, { headers: bearer('not-a-jwt') });
    expect(response.status()).toBe(200);
    expect((await response.json()).map((p: { id: number }) => p.id)).toEqual(anonymous);
  });
});
