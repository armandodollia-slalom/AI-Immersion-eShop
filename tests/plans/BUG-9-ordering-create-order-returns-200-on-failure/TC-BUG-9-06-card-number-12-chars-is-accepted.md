---
id: TC-BUG-9-06
title: A card number of 12 characters (the minimum) is accepted with 200
type: happy
layer: functional
covers: ["Validator: CardNumber length 12-19"]
priority: P2
---

# TC-BUG-9-06: A card number of 12 characters (the minimum) is accepted with 200

## Why

- Boundary just inside the lower limit; guards against the new 400 handling rejecting valid input.

## Preconditions

- Scenario `ordering-two-buyers` loaded (alice owns orders 1-6, bob owns 7 and 8).
- alice has a valid bearer token for the ordering scope.

## Steps

1. `POST http://localhost:18084/api/orders?api-version=1.0` as alice with a fresh GUID in `x-requestid` and a valid `CreateOrderRequest` with one item except `cardNumber` is `401288888888` (12 digits).

## Expected result

- Status is 200.
- alice has 7 orders (a new one in addition to 1-6).
