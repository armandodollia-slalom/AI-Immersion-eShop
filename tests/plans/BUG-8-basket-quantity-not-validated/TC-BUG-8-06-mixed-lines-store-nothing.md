---
id: TC-BUG-8-06
title: A request with one valid and one invalid line leaves an existing basket unchanged
type: sad
sad-path: validation
layer: functional
covers: ["Expected: Redis is unchanged", "Implementation Notes: validation throws before UpdateBasketAsync"]
priority: P1
---

## TC-BUG-8-06: A request with one valid and one invalid line leaves an existing basket unchanged

## Why

- Validation must be all-or-nothing; a partial save of the valid line would still change Redis. Uses bob's seeded basket to also prove prior data is untouched.

## Preconditions

- Test stack up with scenario `basket-edge`; bob has a basket with two items (3 units). Record `redisBasket(bob)` before the call. Token for bob with scope `basket`.

## Steps

1. As bob, call `UpdateBasket` with items `{productId: 7, quantity: 2}` and `{productId: 6, quantity: 0}`.
2. Read bob's basket from Redis.

## Expected result

- Status `INVALID_ARGUMENT`; detail mentions `Product 6` and does not mention `Product 7`.
- `redisBasket(bob)` is identical to the value recorded before the call.
