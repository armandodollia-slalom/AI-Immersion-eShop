---
id: TC-BUG-2-09
title: Buyer shipping with an empty x-requestid gets 403, not 400
type: sad
sad-path: auth
layer: functional
covers: ["Decision: buyer with empty x-requestid gets 403 before the endpoint runs"]
priority: P1
---

# TC-BUG-2-09: Buyer shipping with an empty x-requestid gets 403, not 400

## Why

- Records the changed behavior: the role gate runs before request-id validation. Without this case the old 400 could silently return.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).
- alice has a token with scope `orders`.

## Steps

1. `PUT /api/orders/ship?api-version=1.0` with alice's token, header `x-requestid: 00000000-0000-0000-0000-000000000000`, body `{"orderNumber": 4}`.

## Expected result

- Returns `403`.
- Order 4 still `Paid`.
