---
id: TC-BUG-9-07
title: A card security number of 2 characters is rejected with 400
type: sad
sad-path: boundary
layer: functional
covers: ["Validator: CardSecurityNumber length 3", "Expected: 400 with the validation errors"]
priority: P2
---

# TC-BUG-9-07: A card security number of 2 characters is rejected with 400

## Why

- Boundary just outside the exact-length rule for the security number.

## Preconditions

- Scenario `ordering-two-buyers` loaded (alice owns orders 1-6, bob owns 7 and 8).
- alice has a valid bearer token for the ordering scope.

## Steps

1. `POST http://localhost:18084/api/orders?api-version=1.0` as alice with a fresh GUID in `x-requestid` and a valid `CreateOrderRequest` with one item except `cardSecurityNumber` is `12`.

## Expected result

- Status is 400.
- `errors` has key `CardSecurityNumber` with at least one message.
- alice still has 6 orders.
