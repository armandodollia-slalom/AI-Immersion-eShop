---
id: TC-PROMO-2-29
title: Admin gets one promotion with status and effectiveStatus
type: happy
layer: functional
covers: ["Endpoints: GET /api/promotions/{id}", "Inputs: EffectiveStatus computed"]
priority: P1
---

# TC-PROMO-2-29: Admin gets one promotion with status and effectiveStatus

## Why

- Read contract of the full promotion; seed 1 is Active and 5 is Draft so both computed values are visible.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.

## Steps

1. `GET /api/promotions/1` with the admin token.
2. `GET /api/promotions/5` with the admin token.

## Expected result

- First returns `200`, `id` `1`, name `Fall Hiking Sale`, type `PercentOff`, value `20`, `status` `Published`, `effectiveStatus` `Active`, targets `[{Type,3}]`.
- Second returns `200`, `status` `Draft`, `effectiveStatus` `Draft`.
