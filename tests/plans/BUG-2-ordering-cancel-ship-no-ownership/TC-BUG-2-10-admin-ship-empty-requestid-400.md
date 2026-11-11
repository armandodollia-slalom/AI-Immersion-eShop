---
id: TC-BUG-2-10
title: Admin shipping with an empty x-requestid still gets 400
type: sad
sad-path: validation
layer: functional
covers: ["Decision: admins still get 400 for empty x-requestid"]
priority: P1
---

# TC-BUG-2-10: Admin shipping with an empty x-requestid still gets 400

## Why

- Request-id validation must still work for the role that reaches the endpoint.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).
- `admin` has a token with scope `orders`.

## Steps

1. `PUT /api/orders/ship?api-version=1.0` with the admin token, header `x-requestid: 00000000-0000-0000-0000-000000000000`, body `{"orderNumber": 4}`.

## Expected result

- Returns `400` with body `"Empty GUID is not valid for request ID"`.
- Order 4 still `Paid`.
