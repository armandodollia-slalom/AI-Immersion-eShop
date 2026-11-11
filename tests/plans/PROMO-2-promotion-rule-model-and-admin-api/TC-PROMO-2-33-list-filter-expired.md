---
id: TC-PROMO-2-33
title: List filtered by status=Expired returns only Expired promotions
type: happy
layer: functional
covers: ["Endpoints: list filtered by EffectiveStatus (Expired)"]
priority: P1
---

# TC-PROMO-2-33: List filtered by status=Expired returns only Expired promotions

## Why

- EffectiveStatus is computed from Status and time, so the filter must be translated into time conditions; Expired is one of the four values.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.

## Steps

1. `GET /api/promotions?status=Expired&page=0&pageSize=20` with the admin token.

## Expected result

- Status `200`; the page's items have exactly the id 6 (promotion Published with a past end) and every item has `effectiveStatus` `Expired`.
