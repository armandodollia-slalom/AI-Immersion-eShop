---
id: TC-PROMO-2-60
title: A published coupon-only promotion created through the API is not in /active
type: sad
sad-path: validation
layer: functional
covers: ["Outputs: coupon-only promotions left out of the public feed"]
priority: P1
---

# TC-PROMO-2-60: A published coupon-only promotion created through the API is not in /active

## Why

- Covers promotions created by this API (requiresCoupon true), not only seed data.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Create body V with `requiresCoupon` true, `startsAt` = now - 1 hour, `endsAt` = now + 7 days; call its id `{id}`; publish it.

## Steps

1. `GET /api/promotions/{id}` with the admin token.
2. `GET /api/promotions/active` anonymously.

## Expected result

- Admin GET shows `effectiveStatus` `Active` and `requiresCoupon` `true`.
- `{id}` is absent from `/active`.
