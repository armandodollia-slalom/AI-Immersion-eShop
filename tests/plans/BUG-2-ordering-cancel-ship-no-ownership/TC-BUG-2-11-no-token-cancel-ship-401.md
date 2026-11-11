---
id: TC-BUG-2-11
title: Cancel and ship without a token return 401
type: sad
sad-path: auth
layer: functional
covers: ["Authentication still required on cancel and ship"]
priority: P1
---

# TC-BUG-2-11: Cancel and ship without a token return 401

## Why

- The new policy must not weaken authentication; a fix that only added role handling could still let anonymous calls through the cancel endpoint.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).

## Steps

1. `PUT /api/orders/cancel?api-version=1.0` with no `Authorization` header, a new `x-requestid`, body `{"orderNumber": 1}`.
2. `PUT /api/orders/ship?api-version=1.0` with no `Authorization` header, a new `x-requestid`, body `{"orderNumber": 4}`.

## Expected result

- Both return `401`.
- Orders 1 and 4 keep statuses `Submitted` and `Paid`.
