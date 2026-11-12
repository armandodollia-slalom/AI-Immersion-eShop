---
id: TC-BUG-10-13
title: Shipping a Paid order as admin still returns 200 and ships it
type: happy
layer: functional
covers: ["Regression: valid ship unaffected"]
priority: P1
---

# TC-BUG-10-13: Shipping a Paid order as admin still returns 200 and ships it

## Why

- Same as the cancel regression for the ship endpoint. Order 7 is used so the case does not depend on order 4, which other cases only read.

## Preconditions

- Scenario `ordering-two-buyers` loaded.
- Order 7 (bob) has status Paid.

## Steps

1. `PUT .../api/orders/ship?api-version=1.0` as admin with a new `x-requestid` GUID and body `{"orderNumber": 7}`.
2. `GET .../api/orders/7?api-version=1.0` as bob.

## Expected result

- Ship status is 200.
- Order 7 `status` is `Shipped`.
