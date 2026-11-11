---
id: TC-BUG-8-01
title: UpdateBasket with a negative and a zero quantity is rejected and nothing is stored
type: sad
sad-path: validation
layer: functional
covers: ["Expected: INVALID_ARGUMENT; Redis is unchanged"]
priority: P1
---

## TC-BUG-8-01: UpdateBasket with a negative and a zero quantity is rejected and nothing is stored

## Why

- Reproduction of the bug: `BasketItem.Validate` was never called, so invalid lines were persisted. Functional layer because status code and Redis state need the real service and Redis.

## Preconditions

- Test stack up with scenario `basket-edge`; alice has no basket. Token for alice with scope `basket`.

## Steps

1. As alice, call gRPC `BasketApi.UpdateBasket` with items `{productId: 7, quantity: -3}` and `{productId: 6, quantity: 0}` (`basketCall`/`encodeItems` in `e2e/teststack/basket-api.spec.ts`).
2. Read alice's basket from Redis (`redisBasket(alice)`).

## Expected result

- gRPC status is `INVALID_ARGUMENT`, not `OK`.
- `redisBasket(alice)` is null: no basket key was created.
