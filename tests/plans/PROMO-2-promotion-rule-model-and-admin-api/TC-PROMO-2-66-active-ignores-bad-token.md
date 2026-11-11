---
id: TC-PROMO-2-66
title: /active stays anonymous even with an invalid token
type: happy
layer: functional
covers: ["Endpoints: GET /active anonymous"]
priority: P2
---

# TC-PROMO-2-66: /active stays anonymous even with an invalid token

## Why

- The storefront must not break when it forwards a stale token.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.

## Steps

1. `GET /api/promotions/active` with `Authorization: Bearer not-a-jwt`.

## Expected result

- Status `200` and the same ids as the anonymous call.
