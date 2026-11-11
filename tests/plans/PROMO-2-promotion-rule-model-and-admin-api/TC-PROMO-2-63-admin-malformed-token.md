---
id: TC-PROMO-2-63
title: A malformed bearer token returns 401
type: sad
sad-path: auth
layer: functional
covers: ["Outputs: 401 when the caller isn't an admin"]
priority: P2
---

# TC-PROMO-2-63: A malformed bearer token returns 401

## Why

- An unparsable token must be rejected as unauthenticated, not 500.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.

## Steps

1. `GET /api/promotions?page=0&pageSize=20` with `Authorization: Bearer not-a-jwt`.

## Expected result

- Status `401`.
