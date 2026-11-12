---
id: TC-BUG-10-04
title: Shipping a Cancelled order returns 409 with the rule message
type: sad
sad-path: conflict
layer: functional
covers: ["Technical Notes: SetShippedStatus rule violation (Cancelled)"]
priority: P2
---

# TC-BUG-10-04: Shipping a Cancelled order returns 409 with the rule message

## Why

- A terminal status other than Shipped, so the ship mapping is not special-cased to one status.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- Order 6 (alice) has status Cancelled.

## Steps

1. `PUT http://localhost:18084/api/orders/ship?api-version=1.0` as admin with a new `x-requestid` GUID and body `{"orderNumber": 6}`.

## Expected result

- Status is 409.
- Body `detail` is `Is not possible to change the order status from Cancelled to Shipped.`
