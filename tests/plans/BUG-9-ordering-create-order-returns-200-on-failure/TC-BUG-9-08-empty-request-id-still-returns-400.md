---
id: TC-BUG-9-08
title: An empty x-requestid still returns 400 "RequestId is missing."
type: sad
sad-path: validation
layer: functional
covers: ["Regression: existing RequestId check in CreateOrderAsync"]
priority: P2
---

# TC-BUG-9-08: An empty x-requestid still returns 400 "RequestId is missing."

## Why

- The endpoint now has two 400 shapes (BadRequest string and ValidationProblem); this pins that the existing RequestId check was not changed.

## Preconditions

- Scenario `ordering-two-buyers` loaded (alice owns orders 1-6, bob owns 7 and 8).
- alice has a valid bearer token for the ordering scope.

## Steps

1. `POST http://localhost:18084/api/orders?api-version=1.0` as alice with `x-requestid: 00000000-0000-0000-0000-000000000000` and a valid `CreateOrderRequest` with one item.

## Expected result

- Status is 400.
- Body is the string `RequestId is missing.`.
- alice still has 6 orders.
