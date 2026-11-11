---
id: TC-BUG-8-03
title: A single line with quantity 0 is rejected
type: sad
sad-path: boundary
layer: functional
covers: ["Technical Notes: Quantity < 1 is invalid (boundary 0)"]
priority: P1
---

## TC-BUG-8-03: A single line with quantity 0 is rejected

## Why

- Boundary just outside the minimum of 1; separate from the negative case so each side of the `Quantity < 1` check is proven alone.

## Preconditions

- Test stack up with scenario `basket-edge`; alice has no basket. Token for alice with scope `basket`.

## Steps

1. As alice, call `UpdateBasket` with item `{productId: 6, quantity: 0}`.
2. Read alice's basket from Redis.

## Expected result

- Status `INVALID_ARGUMENT`.
- `redisBasket(alice)` is null.
