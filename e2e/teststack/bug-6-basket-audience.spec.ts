import { test, expect } from '../fixtures';
import { loadScenario } from './scenario';
import { basketCall, encodeItems, getTokens, redisBasket, USER_IDS } from './auth-basket-helpers';

// BUG-6: Basket.API must only accept access tokens issued for the basket audience/scope.
const OK = 0;
const UNAUTHENTICATED = 16;

function payload(jwt: string): { aud?: string | string[] } {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

function audiences(jwt: string): string[] {
  const aud = payload(jwt).aud;
  return aud === undefined ? [] : Array.isArray(aud) ? aud : [aud];
}

test.describe.configure({ mode: 'serial' });

test.describe('BUG-6: basket token audience', () => {
  test.beforeEach(() => {
    loadScenario('bug-6');
  });

  test('TC-BUG-6-01 token without the basket scope cannot update the basket', async () => {
    const token = await test.step('Get an access token without the basket scope', async () =>
      (await getTokens('alice', 'Pass123$', 'openid profile orders')).access_token);
    const res = await test.step('Call UpdateBasket with that token', () =>
      basketCall('UpdateBasket', encodeItems([{ productId: 7, quantity: 1 }]), token));
    await test.step('Read alice\'s basket from Redis', async () => {
      expect(res.grpcStatus).toBe(UNAUTHENTICATED);
      expect(redisBasket(USER_IDS.alice)).toBeNull();
    });
  });

  test('TC-BUG-6-02 token with the basket scope still updates the basket', async () => {
    const token = await test.step('Get an access token with the basket scope', async () =>
      (await getTokens('alice', 'Pass123$', 'openid profile orders basket')).access_token);
    const res = await test.step('Call UpdateBasket with that token', () =>
      basketCall('UpdateBasket', encodeItems([{ productId: 7, quantity: 1 }]), token));
    await test.step('Read alice\'s basket from Redis', async () => {
      expect(res.grpcStatus).toBe(OK);
      expect(res.items).toEqual([{ productId: 7, quantity: 1 }]);
      await expect.poll(() => redisBasket(USER_IDS.alice)).toMatchObject({
        BuyerId: USER_IDS.alice,
        Items: [{ ProductId: 7, Quantity: 1 }],
      });
    });
  });

  test('TC-BUG-6-03 access token requested with the basket scope carries the basket audience', async () => {
    const withScope = await test.step('Decode the token requested with the basket scope', async () =>
      audiences((await getTokens('alice', 'Pass123$', 'openid profile orders basket')).access_token));
    const withoutScope = await test.step('Decode the token requested without the basket scope', async () =>
      audiences((await getTokens('alice', 'Pass123$', 'openid profile orders')).access_token));
    expect(withScope).toContain('basket');
    expect(withoutScope).not.toContain('basket');
  });
});
