---
id: TC-BUG-3-01
title: Bob posts an order with alice's userId; the order is created for bob only
type: sad
sad-path: ownership
layer: functional
covers: ["Expected: order created for the token sub", "Acceptance Criteria 1", "Acceptance Criteria 2 (fixme test)"]
priority: P1
---

# TC-BUG-3-01: Bob posts an order with alice's userId; the order is created for bob only

## Why

- This is the reported bug: a buyer could place orders on another buyer's account (Critical security). Functional layer because it needs the real Ordering.API, auth and database; it is the exact scenario from the fixme test.

## Preconditions

- Test stack running with scenario `ordering-two-buyers` loaded (`testing/teststack load ordering-two-buyers`): alice (`a11ce000-0000-4000-8000-000000000001`) has 6 orders, bob (`b0b00000-0000-4000-8000-000000000002`) has 2.
- Access tokens for alice and bob with the `orders` scope.

## Steps

1. `GET http://localhost:18084/api/orders?api-version=1.0` with bob's token; record the count (2).
2. `POST http://localhost:18084/api/orders?api-version=1.0` with bob's token, header `x-requestid: <new guid>`, and a valid `CreateOrderRequest` with `userId` = alice's id, `userName` = `alice`, one item (productId 2, quantity 2).
3. `GET /api/orders?api-version=1.0` with alice's token.
4. `GET /api/orders?api-version=1.0` with bob's token.

## Expected result

- Step 2 returns `200 OK`.
- Step 3 returns exactly 6 orders (unchanged); none is new.
- Step 4 returns 3 orders: the original 2 plus a new order.
