---
id: TC-PROMO-2-50
title: Publish of an unknown id returns 404
type: sad
sad-path: not-found
layer: functional
covers: ["Errors: 404 if the promotion is unknown"]
priority: P1
---

# TC-PROMO-2-50: Publish of an unknown id returns 404

## Why

- Story names 404.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.

## Steps

1. `POST /api/promotions/99999/publish` with the admin token.

## Expected result

- Status `404`.
