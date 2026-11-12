---
id: TC-BUG-10-08
title: Cancelling an unknown order returns 404
type: sad
sad-path: not-found
layer: functional
covers: ["Suggested fix: return 404 when the order does not exist","Implementation Notes: unknown orders keep 404"]
priority: P1
---

# TC-BUG-10-08: Cancelling an unknown order returns 404

## Why

- The fix must not turn the existing not-found path into 409 or 500. Order 999 does not exist in the scenario.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- No order 999.

## Steps

1. `PUT .../api/orders/cancel?api-version=1.0` as alice with a new `x-requestid` GUID and body `{"orderNumber": 999}`.

## Expected result

- Status is 404.
