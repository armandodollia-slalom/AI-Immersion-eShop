---
id: TC-BUG-1-03
title: Alice cannot read bob's order; response is 404 with no order data
type: sad
sad-path: ownership
layer: functional
covers: ["Expected: 404 NotFound", "Actual: 200 with bob's order", "Acceptance: repro steps match Expected", "Decision: 404 not 403"]
priority: P1
---

# TC-BUG-1-03: Alice cannot read bob's order; response is 404 with no order data

## Why

- This is the reported IDOR (critical). Asserting 404 (the implementation decision) and an empty body proves the order id's existence and data are not revealed.

## Preconditions

- Test stack up with scenario `ordering-two-buyers` loaded. Order 7 belongs to bob; alice has the `orders` scope token.

## Steps

1. Get an access token for alice with the `orders` scope.
2. `GET http://localhost:18084/api/orders/7?api-version=1.0` with alice's bearer token.

## Expected result

- Status 404.
- Body contains none of: `2 Bob Road`, `Portland`, `VenturePro GPS Watch`, `599.97`.
- Not 200 and not 403.
