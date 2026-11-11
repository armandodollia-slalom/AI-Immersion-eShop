---
id: TC-BUG-8-05
title: A line with quantity 1 is accepted and stored
type: happy
layer: functional
covers: ["Technical Notes: Quantity < 1 is invalid (boundary 1 is valid)"]
priority: P1
---

## TC-BUG-8-05: A line with quantity 1 is accepted and stored

## Why

- Boundary just inside the limit; guards against an over-strict fix (for example rejecting `Quantity <= 1`) and proves valid input still saves.

## Preconditions

- Test stack up with scenario `basket-edge`; alice has no basket. Token for alice with scope `basket`.

## Steps

1. As alice, call `UpdateBasket` with item `{productId: 7, quantity: 1}`.
2. Read alice's basket from Redis.
3. Cleanup: call `DeleteBasket` as alice.

## Expected result

- Status `OK`; response contains one item, productId 7, quantity 1.
- `redisBasket(alice)` contains exactly one line: productId 7, quantity 1.
