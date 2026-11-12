---
id: TC-BUG-9-05
title: A card number of 11 characters (just below the minimum) is rejected with 400
type: sad
sad-path: boundary
layer: functional
covers: ["Validator: CardNumber length 12-19", "Expected: 400 with the validation errors"]
priority: P2
---

# TC-BUG-9-05: A card number of 11 characters (just below the minimum) is rejected with 400

## Why

- Boundary just outside the lower limit of the card number length rule; the endpoint must turn the length failure into a 400.

## Preconditions

- Scenario `ordering-two-buyers` loaded (alice owns orders 1-6, bob owns 7 and 8).
- alice has a valid bearer token for the ordering scope.

## Steps

1. `POST http://localhost:18084/api/orders?api-version=1.0` as alice with a fresh GUID in `x-requestid` and a valid `CreateOrderRequest` with one item except `cardNumber` is `40128888888` (11 digits).

## Expected result

- Status is 400.
- `errors` has key `CardNumber` with at least one message.
- alice still has 6 orders.
