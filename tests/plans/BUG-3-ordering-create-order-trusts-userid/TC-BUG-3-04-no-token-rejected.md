---
id: TC-BUG-3-04
title: Create order without a token is rejected and creates nothing
type: sad
sad-path: auth
layer: functional
covers: ["Authentication: create order requires a signed-in user"]
priority: P2
---

# TC-BUG-3-04: Create order without a token is rejected and creates nothing

## Why

- The fix reads the buyer from the token, so the unauthenticated case must stay rejected rather than falling back to the body userId.

## Preconditions

- Test stack running with scenario `ordering-two-buyers` loaded (`testing/teststack load ordering-two-buyers`): alice (`a11ce000-0000-4000-8000-000000000001`) has 6 orders, bob (`b0b00000-0000-4000-8000-000000000002`) has 2.
- Access tokens for alice and bob with the `orders` scope.

## Steps

1. `POST /api/orders?api-version=1.0` with no `Authorization` header, header `x-requestid: <new guid>`, and a valid `CreateOrderRequest` with `userId` = alice's id.
2. `GET /api/orders?api-version=1.0` with alice's token.

## Expected result

- Step 1 returns `401`.
- Step 2 returns exactly 6 orders (unchanged).
