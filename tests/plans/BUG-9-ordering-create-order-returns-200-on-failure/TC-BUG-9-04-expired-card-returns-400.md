---
id: TC-BUG-9-04
title: An expired card is rejected with 400 and the expiration message
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 with the validation errors", "Validator: CardExpiration must be in the future"]
priority: P1
---

# TC-BUG-9-04: An expired card is rejected with 400 and the expiration message

## Why

- Covers a validator rule other than items, with a custom message, to prove the 400 is general and not specific to empty items.

## Preconditions

- Scenario `ordering-two-buyers` loaded (alice owns orders 1-6, bob owns 7 and 8).
- alice has a valid bearer token for the ordering scope.

## Steps

1. `POST http://localhost:18084/api/orders?api-version=1.0` as alice with a fresh GUID in `x-requestid` and a valid `CreateOrderRequest` with one item except `cardExpiration` is one day in the past (UTC ISO 8601).

## Expected result

- Status is 400.
- `errors` has key `CardExpiration` containing `Please specify a valid card expiration date`.
- alice still has 6 orders.
