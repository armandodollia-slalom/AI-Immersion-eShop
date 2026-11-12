---
id: TC-BUG-10-07
title: Retrying a rejected change with the same x-requestid returns 409 again
type: sad
sad-path: conflict
layer: functional
covers: ["Implementation Notes: request id is not recorded, retry gets the same 409"]
priority: P1
---

# TC-BUG-10-07: Retrying a rejected change with the same x-requestid returns 409 again

## Why

- The wrapper used to swallow the error and a duplicate id then looked like success. The story states a retry now gets the same 409; the risk is a silent 200 on retry.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- Order 5 (alice) has status Shipped.

## Steps

1. Pick one GUID G. `PUT .../api/orders/cancel?api-version=1.0` as alice with `x-requestid` = G and body `{"orderNumber": 5}`.
2. Repeat the identical request with `x-requestid` = G.

## Expected result

- Both responses have status 409.
- Both bodies have `detail` `Is not possible to change the order status from Shipped to Cancelled.`
- Order 5 is still `Shipped`.
