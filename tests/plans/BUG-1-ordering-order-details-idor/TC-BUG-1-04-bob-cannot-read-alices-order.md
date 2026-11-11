---
id: TC-BUG-1-04
title: Bob cannot read alice's order
type: sad
sad-path: ownership
layer: functional
covers: ["Expected: another buyer's order is never returned", "Acceptance Criteria: rest of ordering-api spec stays green (Round 1 Q1 = C)"]
priority: P2
---

# TC-BUG-1-04: Bob cannot read alice's order

## Why

- Symmetric direction guards against a fix that only blocks one user or one id range.

## Preconditions

- Test stack up with scenario `ordering-two-buyers` loaded. Order 4 belongs to alice.

## Steps

1. Get an access token for bob with the `orders` scope.
2. `GET http://localhost:18084/api/orders/4?api-version=1.0` with bob's bearer token.

## Expected result

- Status 404.
- Body contains neither the Boston address nor `249.98`.
