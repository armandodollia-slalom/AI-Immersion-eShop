---
id: TC-BUG-10-10
title: Cancelling another buyer's order returns 404, not 409
type: sad
sad-path: ownership
layer: functional
covers: ["Implementation Notes: other buyers' orders keep 404"]
priority: P1
---

# TC-BUG-10-10: Cancelling another buyer's order returns 404, not 409

## Why

- Order 7 is Paid, so a naive implementation that skips the ownership check would answer 409 and leak that the order exists and its status.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- Order 7 belongs to bob and has status Paid.

## Steps

1. `PUT .../api/orders/cancel?api-version=1.0` as alice with a new `x-requestid` GUID and body `{"orderNumber": 7}`.

## Expected result

- Status is 404.
- Body does not contain `Is not possible to change the order status`.
- Order 7 is still `Paid` when read as bob.
