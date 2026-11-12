---
id: TC-BUG-10-11
title: Shipping as a non-Admin still returns 403
type: sad
sad-path: auth
layer: functional
covers: ["Implementation Notes: ship by non-Admin keeps 403 from OrderingAdmin policy"]
priority: P1
---

# TC-BUG-10-11: Shipping as a non-Admin still returns 403

## Why

- The authorization policy runs before the handler; the case guards that the new 409 mapping does not change the order of checks. Order 4 is Paid, so shipping would otherwise succeed.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- Order 4 (alice) has status Paid.

## Steps

1. `PUT .../api/orders/ship?api-version=1.0` as alice (no Admin role) with a new `x-requestid` GUID and body `{"orderNumber": 4}`.

## Expected result

- Status is 403.
- Order 4 is still `Paid`.
