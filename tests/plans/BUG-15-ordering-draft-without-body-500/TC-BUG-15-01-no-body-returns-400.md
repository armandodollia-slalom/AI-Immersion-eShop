---
id: TC-BUG-15-01
title: Draft without a body is rejected with 400 and creates no order
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest", "Code map: missing body returns 400 ValidationProblem (key empty)"]
priority: P1
---

# TC-BUG-15-01: Draft without a body is rejected with 400 and creates no order

## Why

- This is the reported bug: a bodyless draft request gave 500. It is the story's reproduction and the acceptance criterion, so it needs its own case. Functional layer because it needs the real minimal-API binding in Ordering.API, which a unit test would not exercise.

## Preconditions

- Test stack running with scenario `ordering-two-buyers` loaded (`testing/teststack load ordering-two-buyers`).
- User alice (id `ALICE_ID` from the scenario) with a valid `ordering` token; alice has 6 orders.

## Steps

1. `POST http://localhost:18084/api/orders/draft?api-version=1.0` with alice's bearer token, no request body and no Content-Type header.
2. `GET http://localhost:18084/api/orders?api-version=1.0` with alice's token.

## Expected result

- Step 1: status `400` (not 500); content type `application/problem+json`; body `status` is `400`; `errors` has the key `""` with exactly one non-empty message.
- Step 2: status `200` and alice still has exactly 6 orders.
