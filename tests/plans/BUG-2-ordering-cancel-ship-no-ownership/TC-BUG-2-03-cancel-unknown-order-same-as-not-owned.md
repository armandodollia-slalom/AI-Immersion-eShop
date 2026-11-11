---
id: TC-BUG-2-03
title: Cancelling an unknown order returns the same 404 as a not-owned order
type: sad
sad-path: not-found
layer: functional
covers: ["Decision: 404 for orders the caller does not own and for orders that do not exist"]
priority: P1
---

# TC-BUG-2-03: Cancelling an unknown order returns the same 404 as a not-owned order

## Why

- The decision is that callers must not tell the two cases apart; a different status or body would leak which order numbers exist.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).
- alice has a token with scope `orders`.

## Steps

1. `PUT /api/orders/cancel?api-version=1.0` with alice's token, a new `x-requestid`, body `{"orderNumber": 999}`.
2. Repeat with body `{"orderNumber": 7}` (bob's order) and a new `x-requestid`.

## Expected result

- Both steps return `404`.
- Status code and response body of step 1 equal those of step 2.
