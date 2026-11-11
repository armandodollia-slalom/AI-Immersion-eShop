---
id: TC-BUG-2-01
title: Alice cannot cancel bob's order; reported as 404 and the order is unchanged
type: sad
sad-path: ownership
layer: functional
covers: ["Expected: 404 or 403 and status unchanged", "Cancel ownership check"]
priority: P0
---

# TC-BUG-2-01: Alice cannot cancel bob's order; reported as 404 and the order is unchanged

## Why

- This is the reported cancel hole: before the fix any signed-in user could cancel any order. Functional because the check spans the API, query and database.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).
- alice has an access token with scope `orders`.

## Steps

1. `PUT http://localhost:18084/api/orders/cancel?api-version=1.0` with `Authorization: Bearer <alice token>`, header `x-requestid: <new guid>`, body `{"orderNumber": 7}`.
2. `GET /api/orders/7?api-version=1.0` with bob's token.

## Expected result

- Step 1 returns `404` (no body detail naming ownership).
- Step 2 returns `200` with `status` `Paid`, unchanged.
