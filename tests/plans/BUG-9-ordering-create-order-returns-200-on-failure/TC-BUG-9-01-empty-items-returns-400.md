---
id: TC-BUG-9-01
title: An order with an empty items list is rejected with 400 and the validator message
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest with the validation errors", "Actual: 200 OK"]
priority: P0
---

# TC-BUG-9-01: An order with an empty items list is rejected with 400 and the validator message

## Why

- This is the reported bug: the command fails validation and the endpoint answered 200. The risk is a client treating a failed create as success; functional layer because it needs the real MediatR validation pipeline.

## Preconditions

- Scenario `ordering-two-buyers` loaded (alice owns orders 1-6, bob owns 7 and 8).
- alice has a valid bearer token for the ordering scope.

## Steps

1. `POST http://localhost:18084/api/orders?api-version=1.0` as alice with a fresh GUID in `x-requestid` and a `CreateOrderRequest` that is valid except `items` is `[]` (city Redmond, street 1 Microsoft Way, state WA, country U.S., zipCode 98052, cardNumber 4012888888881881, cardHolderName Test Holder, cardExpiration one year ahead, cardSecurityNumber 123, cardTypeId 2).

## Expected result

- Status is 400 (not 200).
- Body is a validation problem (`application/problem+json`, `status` 400) whose `errors` object contains key `OrderItems` with the message `No order items found`.
- `errors` has no key for any other property.
