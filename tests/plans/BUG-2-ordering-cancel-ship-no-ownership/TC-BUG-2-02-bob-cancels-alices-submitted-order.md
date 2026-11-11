---
id: TC-BUG-2-02
title: Bob cannot cancel alice's cancellable Submitted order
type: sad
sad-path: ownership
layer: functional
covers: ["Cancel ownership check", "Order would otherwise be cancellable"]
priority: P0
---

# TC-BUG-2-02: Bob cannot cancel alice's cancellable Submitted order

## Why

- Order 7 is Paid so a rejected cancel there could come from the state rule. A Submitted order is cancellable, so only the ownership check can reject it.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).
- bob has an access token with scope `orders`.

## Steps

1. `PUT /api/orders/cancel?api-version=1.0` with bob's token, a new `x-requestid`, body `{"orderNumber": 1}` (alice's Submitted order).
2. `GET /api/orders/1?api-version=1.0` with alice's token.

## Expected result

- Step 1 returns `404`.
- Step 2 shows order 1 `status` `Submitted`, description unchanged (not "The order was cancelled.").
