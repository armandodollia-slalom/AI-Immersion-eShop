---
id: TC-BUG-8-04
title: A single line with quantity -1 is rejected
type: sad
sad-path: boundary
layer: functional
covers: ["Technical Notes: Quantity < 1 is invalid (negative)"]
priority: P2
---

## TC-BUG-8-04: A single line with quantity -1 is rejected

## Why

- -1 is the negative neighbor of zero; proves a negative alone (without a zero line) is rejected.

## Preconditions

- Test stack up with scenario `basket-edge`; alice has no basket. Token for alice with scope `basket`.

## Steps

1. As alice, call `UpdateBasket` with item `{productId: 7, quantity: -1}`.
2. Read alice's basket from Redis.

## Expected result

- Status `INVALID_ARGUMENT`.
- `redisBasket(alice)` is null.
