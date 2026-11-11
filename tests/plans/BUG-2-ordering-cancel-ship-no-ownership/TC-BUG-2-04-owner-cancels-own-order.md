---
id: TC-BUG-2-04
title: Owner can still cancel their own Submitted order
type: happy
layer: functional
covers: ["Cancel of own order still returns 200"]
priority: P0
---

# TC-BUG-2-04: Owner can still cancel their own Submitted order

## Why

- Guards against a fix that rejects every cancel. Proves the ownership check passes for the owner.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).
- alice has a token with scope `orders`.

## Steps

1. `PUT /api/orders/cancel?api-version=1.0` with alice's token, a new `x-requestid`, body `{"orderNumber": 1}`.
2. `GET /api/orders/1?api-version=1.0` with alice's token.

## Expected result

- Step 1 returns `200`.
- Step 2 shows `status` `Cancelled` and `description` "The order was cancelled.".
