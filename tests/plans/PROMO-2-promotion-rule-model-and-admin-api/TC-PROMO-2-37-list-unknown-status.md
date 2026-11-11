---
id: TC-PROMO-2-37
title: Unknown status filter returns 400
type: sad
sad-path: validation
layer: functional
covers: ["Endpoints: status filter takes an EffectiveStatus value"]
priority: P1
---

# TC-PROMO-2-37: Unknown status filter returns 400

## Why

- A typo in the filter should be reported, not silently return everything.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.

## Steps

1. `GET /api/promotions?status=Bogus&page=0&pageSize=20` with the admin token.

## Expected result

- Status `400` with a ValidationProblem body whose `errors` has the key `status`.
