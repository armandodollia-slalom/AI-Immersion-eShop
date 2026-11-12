---
id: TC-BUG-10-06
title: A rejected status change leaves the order unchanged
type: sad
sad-path: conflict
layer: functional
covers: ["Implementation Notes: rethrown domain error rolls back the outer transaction"]
priority: P1
---

# TC-BUG-10-06: A rejected status change leaves the order unchanged

## Why

- Rethrowing from the idempotency wrapper must not persist a partial change; this checks the rollback by reading the order afterwards.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- Order 5 (alice) has status Shipped; order 4 (alice) has status Paid.

## Steps

1. `PUT .../api/orders/cancel?api-version=1.0` as alice with a new `x-requestid` GUID and body `{"orderNumber": 5}`; expect 409.
2. `PUT .../api/orders/cancel?api-version=1.0` as alice with a new `x-requestid` GUID and body `{"orderNumber": 4}`; expect 409.
3. `GET http://localhost:18084/api/orders/5?api-version=1.0` and `GET .../api/orders/4?api-version=1.0` as alice.

## Expected result

- Order 5 `status` is `Shipped`.
- Order 4 `status` is `Paid`.
