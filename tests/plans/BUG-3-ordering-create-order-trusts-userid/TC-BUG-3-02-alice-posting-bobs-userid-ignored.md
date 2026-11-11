---
id: TC-BUG-3-02
title: Alice posts an order with bob's userId; the order is created for alice only
type: sad
sad-path: ownership
layer: functional
covers: ["Expected: order created for the token sub", "Acceptance Criteria 2 (rest of spec)"]
priority: P2
---

# TC-BUG-3-02: Alice posts an order with bob's userId; the order is created for alice only

## Why

- Checks the fix works in both directions and is not hard-wired to bob; the id comes from each caller's token.

## Preconditions

- Test stack running with scenario `ordering-two-buyers` loaded (`testing/teststack load ordering-two-buyers`): alice (`a11ce000-0000-4000-8000-000000000001`) has 6 orders, bob (`b0b00000-0000-4000-8000-000000000002`) has 2.
- Access tokens for alice and bob with the `orders` scope.

## Steps

1. `GET /api/orders?api-version=1.0` with alice's token and with bob's token; record the counts (6 and 2).
2. `POST /api/orders?api-version=1.0` with alice's token, header `x-requestid: <new guid>`, and a valid `CreateOrderRequest` with `userId` = bob's id and `userName` = `bob`.
3. `GET /api/orders?api-version=1.0` with each token again.

## Expected result

- Step 2 returns `200 OK`.
- Alice's list has 7 orders; bob's list still has 2.
