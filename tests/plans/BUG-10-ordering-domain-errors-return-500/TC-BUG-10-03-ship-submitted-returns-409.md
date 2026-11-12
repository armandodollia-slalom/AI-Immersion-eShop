---
id: TC-BUG-10-03
title: Shipping a Submitted order returns 409 with the rule message
type: sad
sad-path: conflict
layer: functional
covers: ["Technical Notes: SetShippedStatus rule violation","Suggested fix: map to 409"]
priority: P1
---

# TC-BUG-10-03: Shipping a Submitted order returns 409 with the rule message

## Why

- The ship endpoint has its own 500 mapping, so cancel being fixed does not prove ship is. Submitted is the unpaid source status used by the existing e2e test.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- Order 2 (alice) has status Submitted, dated 2099 so no background processor moves it.
- admin user exists (role Admin).

## Steps

1. `PUT http://localhost:18084/api/orders/ship?api-version=1.0` as admin with a new `x-requestid` GUID and body `{"orderNumber": 2}`.

## Expected result

- Status is 409.
- Body `detail` is `Is not possible to change the order status from Submitted to Shipped.`
