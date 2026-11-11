---
id: TC-BUG-3-03
title: Bob posts an order with his own userId; the order is created for bob
type: happy
layer: functional
covers: ["Expected: order created for the token sub", "Acceptance Criteria 2 (rest of spec)"]
priority: P2
---

# TC-BUG-3-03: Bob posts an order with his own userId; the order is created for bob

## Why

- Guards against the fix breaking the normal case where body and token agree (existing WebApp and ClientApp clients send their own id).

## Preconditions

- Test stack running with scenario `ordering-two-buyers` loaded (`testing/teststack load ordering-two-buyers`): alice (`a11ce000-0000-4000-8000-000000000001`) has 6 orders, bob (`b0b00000-0000-4000-8000-000000000002`) has 2.
- Access tokens for alice and bob with the `orders` scope.

## Steps

1. `GET /api/orders?api-version=1.0` with bob's token; record the count (2).
2. `POST /api/orders?api-version=1.0` with bob's token, header `x-requestid: <new guid>`, and a valid `CreateOrderRequest` with `userId` = bob's id, `userName` = `bob`.
3. `GET /api/orders?api-version=1.0` with bob's token and with alice's token.

## Expected result

- Step 2 returns `200 OK`.
- Bob's list has 3 orders; alice's list still has 6.
