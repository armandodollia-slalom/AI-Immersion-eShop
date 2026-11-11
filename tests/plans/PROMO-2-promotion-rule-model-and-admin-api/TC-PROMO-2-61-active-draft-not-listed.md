---
id: TC-PROMO-2-61
title: A Draft created through the API is not in /active
type: sad
sad-path: validation
layer: functional
covers: ["AC: only active promotions are in /active"]
priority: P2
---

# TC-PROMO-2-61: A Draft created through the API is not in /active

## Why

- Draft with an open window must stay hidden.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Create a Draft with body V but `startsAt` = now - 1 hour; call its id `{id}`.

## Steps

1. `GET /api/promotions/active` anonymously.

## Expected result

- `{id}` is absent.
