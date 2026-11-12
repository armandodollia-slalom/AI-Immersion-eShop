---
id: TC-BUG-10-12
title: Cancelling a Submitted order still returns 200 and cancels it
type: happy
layer: functional
covers: ["Regression: valid cancel unaffected"]
priority: P1
---

# TC-BUG-10-12: Cancelling a Submitted order still returns 200 and cancels it

## Why

- Guards against the fix over-mapping errors; the success path goes through the changed idempotency wrapper.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- Order 1 (alice) has status Submitted.

## Steps

1. `PUT .../api/orders/cancel?api-version=1.0` as alice with a new `x-requestid` GUID and body `{"orderNumber": 1}`.
2. `GET .../api/orders/1?api-version=1.0` as alice.

## Expected result

- Cancel status is 200.
- Order 1 `status` is `Cancelled`.
