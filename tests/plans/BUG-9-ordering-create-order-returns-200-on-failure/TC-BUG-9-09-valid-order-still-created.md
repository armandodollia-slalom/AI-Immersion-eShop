---
id: TC-BUG-9-09
title: A valid order is still created with 200
type: happy
layer: functional
covers: ["Regression: success path returns Ok", "Acceptance: rest of ordering-api.spec.ts still passes"]
priority: P0
---

# TC-BUG-9-09: A valid order is still created with 200

## Why

- Guards the success path against regressions from the new failure handling: a 200 must still mean an order was created.

## Preconditions

- Scenario `ordering-two-buyers` loaded (alice owns orders 1-6, bob owns 7 and 8).
- alice has a valid bearer token for the ordering scope.

## Steps

1. `POST http://localhost:18084/api/orders?api-version=1.0` as alice with a fresh GUID in `x-requestid` and a valid `CreateOrderRequest` (one item, productId 2, quantity 2, unitPrice 89.99, all fields as in TC-BUG-9-01).
2. `GET /api/orders?api-version=1.0` as alice.

## Expected result

- Step 1 returns 200.
- Step 2 returns 7 orders, the new one being in status `Submitted`.
- bob still has 2 orders.
