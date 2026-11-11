---
id: TC-BUG-6-01
title: Token without the basket scope cannot update the basket
type: sad
sad-path: auth
layer: functional
covers: ["Expected: UNAUTHENTICATED, nothing written to Redis", "Acceptance Criteria: steps repeated match Expected"]
priority: P1
---

# TC-BUG-6-01: Token without the basket scope cannot update the basket

## Why

- This is the bug itself: any Identity token was accepted by Basket.API because audience validation was off, so writes happened with a token never issued for the basket API. gRPC against real Redis is the cheapest layer that shows both the status and the absence of a write.

## Preconditions

- Test stack up with the `basket-edge` scenario loaded.
- alice (`a11ce000-0000-4000-8000-000000000001`, password `Pass123$`) has no basket in Redis.

## Steps

1. Call `getTokens('alice', 'Pass123$', 'openid profile orders')` and take `access_token` (no `basket` scope).
2. Call gRPC `BasketApi.UpdateBasket` on `http://localhost:18083` with that bearer token and one item `{ productId: 7, quantity: 1 }`.
3. Read alice's basket key from Redis.

## Expected result

- The gRPC status is `UNAUTHENTICATED` (code 16), not `OK`.
- Redis holds no basket for alice's user id (`redisBasket(USER_IDS.alice)` is null).
