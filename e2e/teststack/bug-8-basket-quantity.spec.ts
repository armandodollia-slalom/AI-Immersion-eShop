import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { basketCall, encodeItems, getTokens, redisBasket, USER_IDS } from './auth-basket-helpers';

// BUG-8: Basket.API UpdateBasket must reject lines with quantity < 1 (INVALID_ARGUMENT) before writing to Redis.
// Scenario bug-8: alice has no basket; bob has products 7 x2 and 6 x1.
const OK = 0;
const INVALID_ARGUMENT = 3;

test.describe.configure({ mode: 'serial' });

test.describe('BUG-8: basket quantity validation', () => {
  let aliceToken: string;
  let bobToken: string;

  test.beforeAll(async () => {
    loadScenario('bug-8');
    aliceToken = (await getTokens('alice')).access_token;
    bobToken = (await getTokens('bob')).access_token;
  });

  test('TC-BUG-8-01 zero and negative quantities are rejected and nothing is stored', async () => {
    const res = await test.step('As alice, UpdateBasket with product 7 x -3 and product 6 x 0', () =>
      basketCall('UpdateBasket', encodeItems([{ productId: 7, quantity: -3 }, { productId: 6, quantity: 0 }]), aliceToken));
    await test.step('Status is INVALID_ARGUMENT and alice has no basket in Redis', () => {
      expect(res.grpcStatus).toBe(INVALID_ARGUMENT);
      expect(redisBasket(USER_IDS.alice)).toBeNull();
    });
  });

  test('TC-BUG-8-02 the message lists every invalid line', async () => {
    const res = await test.step('As alice, UpdateBasket with product 7 x -3 and product 6 x 0', () =>
      basketCall('UpdateBasket', encodeItems([{ productId: 7, quantity: -3 }, { productId: 6, quantity: 0 }]), aliceToken));
    await test.step('Status is INVALID_ARGUMENT with both lines in the detail', () => {
      expect(res.grpcStatus).toBe(INVALID_ARGUMENT);
      expect(res.grpcMessage).toBe('Invalid basket items: Product 7: Invalid number of units (-3); Product 6: Invalid number of units (0)');
    });
  });

  test('TC-BUG-8-03 a single line with quantity 0 is rejected', async () => {
    const res = await test.step('As alice, UpdateBasket with product 6 x 0', () =>
      basketCall('UpdateBasket', encodeItems([{ productId: 6, quantity: 0 }]), aliceToken));
    await test.step('Status is INVALID_ARGUMENT and alice has no basket in Redis', () => {
      expect(res.grpcStatus).toBe(INVALID_ARGUMENT);
      expect(redisBasket(USER_IDS.alice)).toBeNull();
    });
  });

  test('TC-BUG-8-04 a single line with quantity -1 is rejected', async () => {
    const res = await test.step('As alice, UpdateBasket with product 7 x -1', () =>
      basketCall('UpdateBasket', encodeItems([{ productId: 7, quantity: -1 }]), aliceToken));
    await test.step('Status is INVALID_ARGUMENT and alice has no basket in Redis', () => {
      expect(res.grpcStatus).toBe(INVALID_ARGUMENT);
      expect(redisBasket(USER_IDS.alice)).toBeNull();
    });
  });

  test('TC-BUG-8-05 a line with quantity 1 is accepted and stored', async () => {
    try {
      const res = await test.step('As alice, UpdateBasket with product 7 x 1', () =>
        basketCall('UpdateBasket', encodeItems([{ productId: 7, quantity: 1 }]), aliceToken));
      await test.step('Status is OK, response and Redis hold exactly product 7 x 1', async () => {
        expect(res.grpcStatus).toBe(OK);
        expect(res.items).toEqual([{ productId: 7, quantity: 1 }]);
        await expect.poll(() => (redisBasket(USER_IDS.alice)?.Items ?? []).map(i => ({ ProductId: i.ProductId, Quantity: i.Quantity })))
          .toEqual([{ ProductId: 7, Quantity: 1 }]);
      });
    } finally {
      await test.step('Cleanup: DeleteBasket as alice', async () => {
        await basketCall('DeleteBasket', undefined, aliceToken);
      });
    }
  });

  test('TC-BUG-8-06 a mixed valid/invalid request leaves an existing basket unchanged', async () => {
    const before = redisBasket(USER_IDS.bob);
    expect(before).not.toBeNull();
    const res = await test.step('As bob, UpdateBasket with product 7 x 2 and product 6 x 0', () =>
      basketCall('UpdateBasket', encodeItems([{ productId: 7, quantity: 2 }, { productId: 6, quantity: 0 }]), bobToken));
    await test.step('Status is INVALID_ARGUMENT naming only Product 6; bob\'s basket is unchanged', () => {
      expect(res.grpcStatus).toBe(INVALID_ARGUMENT);
      expect(res.grpcMessage).toContain('Product 6');
      expect(res.grpcMessage).not.toContain('Product 7');
      expect(redisBasket(USER_IDS.bob)).toEqual(before);
    });
  });

  test('TC-BUG-8-07 an update with no items is still accepted', async () => {
    try {
      const res = await test.step('As alice, UpdateBasket with no items', () =>
        basketCall('UpdateBasket', encodeItems([]), aliceToken));
      await test.step('Status is OK with zero items', () => {
        expect(res.grpcStatus).toBe(OK);
        expect(res.items).toEqual([]);
      });
    } finally {
      await test.step('Cleanup: DeleteBasket as alice', async () => {
        await basketCall('DeleteBasket', undefined, aliceToken);
      });
    }
  });
});
