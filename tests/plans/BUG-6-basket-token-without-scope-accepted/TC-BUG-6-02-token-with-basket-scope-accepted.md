---
id: TC-BUG-6-02
title: Token with the basket scope still updates the basket
type: happy
layer: functional
covers: ["Acceptance Criteria: the rest of basket-api.spec.ts still passes", "Technical Notes: validate the audience"]
priority: P1
---

# TC-BUG-6-02: Token with the basket scope still updates the basket

## Why

- Turning on audience validation could lock out legitimate callers if the audience or scopes are misconfigured. This guards the positive side of the fix so the rejection in TC-BUG-6-01 is not just "everything is rejected".

## Preconditions

- Test stack up with the `basket-edge` scenario loaded.
- alice has no basket in Redis.

## Steps

1. Call `getTokens('alice', 'Pass123$', 'openid profile orders basket')` and take `access_token`.
2. Call gRPC `BasketApi.UpdateBasket` on `http://localhost:18083` with that bearer token and one item `{ productId: 7, quantity: 1 }`.
3. Read alice's basket key from Redis.

## Expected result

- The gRPC status is `OK` (code 0).
- The response contains one item with `productId` 7 and `quantity` 1.
- Redis holds alice's basket with that single item.
