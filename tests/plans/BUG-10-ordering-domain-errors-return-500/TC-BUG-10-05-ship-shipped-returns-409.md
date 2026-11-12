---
id: TC-BUG-10-05
title: Shipping an already Shipped order returns 409 with the rule message
type: sad
sad-path: conflict
layer: functional
covers: ["Technical Notes: SetShippedStatus rule violation (Shipped)"]
priority: P2
---

# TC-BUG-10-05: Shipping an already Shipped order returns 409 with the rule message

## Why

- Shipping twice is a plausible real user mistake and was listed as an invalid transition in the existing e2e test.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- Order 5 (alice) has status Shipped.

## Steps

1. `PUT http://localhost:18084/api/orders/ship?api-version=1.0` as admin with a new `x-requestid` GUID and body `{"orderNumber": 5}`.

## Expected result

- Status is 409.
- Body `detail` is `Is not possible to change the order status from Shipped to Shipped.`
