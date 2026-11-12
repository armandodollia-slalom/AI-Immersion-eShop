---
id: TC-BUG-9-03
title: Several validation failures are returned together, grouped by property
type: sad
sad-path: validation
layer: functional
covers: ["Implementation Notes: errors grouped by PropertyName", "Expected: 400 with the validation errors"]
priority: P1
---

# TC-BUG-9-03: Several validation failures are returned together, grouped by property

## Why

- The story returns the validator's messages grouped by property, so one response must carry every failure rather than only the first. Risk: a client fixing errors one request at a time.

## Preconditions

- Scenario `ordering-two-buyers` loaded (alice owns orders 1-6, bob owns 7 and 8).
- alice has a valid bearer token for the ordering scope.

## Steps

1. `POST http://localhost:18084/api/orders?api-version=1.0` as alice with a fresh GUID in `x-requestid` and a valid `CreateOrderRequest` with items (one item, productId 2, quantity 2) except `city` is `""` and `zipCode` is `""`.

## Expected result

- Status is 400.
- `errors` contains keys `City` and `ZipCode`, each with exactly one message mentioning the property name.
- `errors` has no `OrderItems` key.
- alice still has 6 orders.
