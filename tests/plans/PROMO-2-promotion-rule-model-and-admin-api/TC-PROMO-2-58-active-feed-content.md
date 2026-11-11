---
id: TC-PROMO-2-58
title: Anonymous /active returns only active, non-coupon promotions
type: happy
layer: functional
covers: ["AC: anonymous caller gets only active promotions that don't need a coupon", "Outputs: coupon-only promotions left out"]
priority: P1
---

# TC-PROMO-2-58: Anonymous /active returns only active, non-coupon promotions

## Why

- Main public-feed filter: excludes coupon-only (4), Draft (5), Expired (6), Scheduled (7).

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- No Authorization header.

## Steps

1. `GET /api/promotions/active` with no token.

## Expected result

- Status `200`; the array contains exactly the ids 1, 2, 3, compared as a set (the story states no feed order).
- Ids 4, 5, 6 and 7 are absent.
