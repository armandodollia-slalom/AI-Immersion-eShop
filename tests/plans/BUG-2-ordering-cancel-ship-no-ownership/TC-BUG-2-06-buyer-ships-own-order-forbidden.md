---
id: TC-BUG-2-06
title: Buyer cannot ship even their own Paid order
type: sad
sad-path: auth
layer: functional
covers: ["Shipping limited to a back-office role, not buyers", "Policy OrderingAdmin"]
priority: P0
---

# TC-BUG-2-06: Buyer cannot ship even their own Paid order

## Why

- The story says shipping is a back-office action, not just an ownership matter. Order 4 is alice's own Paid order, so only the role check can reject it.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).
- alice has a token with scope `orders`.

## Steps

1. `PUT /api/orders/ship?api-version=1.0` with alice's token, a new `x-requestid`, body `{"orderNumber": 4}`.
2. `GET /api/orders/4?api-version=1.0` with alice's token.

## Expected result

- Step 1 returns `403`.
- Step 2 shows `status` `Paid`, unchanged.
