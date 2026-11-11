---
id: TC-PROMO-2-09
title: Name of exactly 100 characters is accepted
type: happy
layer: functional
covers: ["Inputs: Name max 100 (inside boundary)"]
priority: P1
---

# TC-PROMO-2-09: Name of exactly 100 characters is accepted

## Why

- Just-inside boundary for name length.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Body V with `name` = 100 times `a`.

## Steps

1. `POST /api/promotions` with the admin token and the body above.

## Expected result

- Status `201`; the returned `name` has 100 characters.
