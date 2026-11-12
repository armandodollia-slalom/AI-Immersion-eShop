---
id: TC-BUG-10-02
title: Cancelling a Paid order returns 409 with the rule message
type: sad
sad-path: conflict
layer: functional
covers: ["Technical Notes: SetCancelledStatus rule violation (Paid)"]
priority: P1
---

# TC-BUG-10-02: Cancelling a Paid order returns 409 with the rule message

## Why

- SetCancelledStatus rejects Paid as well as Shipped; a second source status proves the mapping is generic and not tied to one status.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- alice owns order 4 with status Paid.

## Steps

1. `PUT http://localhost:18084/api/orders/cancel?api-version=1.0` as alice with a new `x-requestid` GUID and body `{"orderNumber": 4}`.

## Expected result

- Status is 409.
- Body `detail` is `Is not possible to change the order status from Paid to Cancelled.`
