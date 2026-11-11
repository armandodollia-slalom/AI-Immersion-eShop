---
id: TC-BUG-2-05
title: Buyer alice cannot ship bob's Paid order; 403 and order unchanged
type: sad
sad-path: auth
layer: functional
covers: ["Steps to Reproduce", "Expected: 403 or 404, status unchanged", "Ship requires Admin"]
priority: P0
---

# TC-BUG-2-05: Buyer alice cannot ship bob's Paid order; 403 and order unchanged

## Why

- This is the exact reproduction in the story (alice ships order 7). A buyer must be stopped by the Admin policy before the endpoint runs.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).
- alice has a token with scope `orders`.

## Steps

1. `PUT http://localhost:18084/api/orders/ship?api-version=1.0` with alice's token, a new `x-requestid`, body `{"orderNumber": 7}`.
2. `GET /api/orders/7?api-version=1.0` with bob's token.

## Expected result

- Step 1 returns `403`.
- Step 2 shows `status` `Paid` and description "Paid.", unchanged.
