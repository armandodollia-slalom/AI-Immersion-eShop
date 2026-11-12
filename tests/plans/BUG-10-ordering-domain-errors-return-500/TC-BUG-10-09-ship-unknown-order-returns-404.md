---
id: TC-BUG-10-09
title: Shipping an unknown order returns 404
type: sad
sad-path: not-found
layer: functional
covers: ["Suggested fix: return 404 when the order does not exist"]
priority: P1
---

# TC-BUG-10-09: Shipping an unknown order returns 404

## Why

- Ship has a separate existence check from cancel; it needs its own check.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- No order 999.

## Steps

1. `PUT .../api/orders/ship?api-version=1.0` as admin with a new `x-requestid` GUID and body `{"orderNumber": 999}`.

## Expected result

- Status is 404.
