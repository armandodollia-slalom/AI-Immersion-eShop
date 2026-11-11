---
id: TC-BUG-1-02
title: Second buyer reads own order details
type: happy
layer: functional
covers: ["Expected: owner still gets own order"]
priority: P2
---

# TC-BUG-1-02: Second buyer reads own order details

## Why

- Confirms the identity filter works for a different buyer than alice, so the fix is not hard-coded to one user.

## Preconditions

- Test stack up with scenario `ordering-two-buyers` loaded. bob (identity b0b00000-0000-4000-8000-000000000002) owns order 7 (Paid, 2 Bob Road, Portland, 3 x 199.99 = 599.97).

## Steps

1. Get an access token for bob with the `orders` scope.
2. `GET http://localhost:18084/api/orders/7?api-version=1.0` with bob's bearer token.

## Expected result

- Status 200.
- Body has `orderNumber` 7, address street `2 Bob Road`, city Portland and `total` 599.97.
