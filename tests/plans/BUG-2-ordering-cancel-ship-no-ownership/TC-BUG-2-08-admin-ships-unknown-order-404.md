---
id: TC-BUG-2-08
title: Admin shipping an unknown order number gets 404
type: sad
sad-path: not-found
layer: functional
covers: ["Decision: admin shipping an unknown order gets 404", "OrderExistsAsync"]
priority: P1
---

# TC-BUG-2-08: Admin shipping an unknown order number gets 404

## Why

- Covers the new existence check; before it, an unknown order failed differently. Admin is used so the role gate is passed.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).
- `admin` has a token with scope `orders`.

## Steps

1. `PUT /api/orders/ship?api-version=1.0` with the admin token, a new `x-requestid`, body `{"orderNumber": 999}`.

## Expected result

- Returns `404`.
- Orders 1-8 keep their scenario statuses.
