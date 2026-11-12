---
id: TC-BUG-10-01
title: Cancelling a Shipped order returns 409 with the rule message
type: sad
sad-path: conflict
layer: functional
covers: ["Expected 409 with message","Acceptance: repeat steps","Technical Notes: SetCancelledStatus"]
priority: P1
---

# TC-BUG-10-01: Cancelling a Shipped order returns 409 with the rule message

## Why

- This is the exact reproduction in the bug report; it returned 500 before. Functional layer because the status mapping and the domain rule only meet in the running API with a real database.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- alice owns order 5 with status Shipped.

## Steps

1. `PUT http://localhost:18084/api/orders/cancel?api-version=1.0` as alice with `x-requestid` = a new GUID and body `{"orderNumber": 5}`.

## Expected result

- Status is 409 (not 500).
- Content type is `application/problem+json`; body `status` is 409.
- Body `detail` is `Is not possible to change the order status from Shipped to Cancelled.`
- Body does not contain `Cancel order failed to process.`
