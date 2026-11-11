---
id: TC-BUG-1-01
title: Buyer reads own order details
type: happy
layer: functional
covers: ["Expected: owner still gets own order", "Acceptance: rest of ordering-api spec passes"]
priority: P1
---

# TC-BUG-1-01: Buyer reads own order details

## Why

- Fix filters by caller identity; a wrong filter would break the legitimate read, so the happy path guards against over-blocking. Functional layer: the bug is an API-level check.

## Preconditions

- Test stack up with scenario `ordering-two-buyers` loaded. alice (identity a11ce000-0000-4000-8000-000000000001) owns order 4 (Paid, Boston address, items 179.99 + 69.99 = 249.98).

## Steps

1. Get an access token for alice with the `orders` scope.
2. `GET http://localhost:18084/api/orders/4?api-version=1.0` with `Authorization: Bearer <alice token>`.

## Expected result

- Status 200.
- Body has `orderNumber` 4, `status` Paid, the Boston address, the two items and `total` 249.98.
