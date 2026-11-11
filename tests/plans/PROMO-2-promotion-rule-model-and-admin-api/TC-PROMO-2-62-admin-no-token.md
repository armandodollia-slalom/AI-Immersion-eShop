---
id: TC-PROMO-2-62
title: Every admin endpoint returns 401 without a token
type: sad
sad-path: auth
layer: functional
covers: ["AC: anonymous caller on any admin endpoint -> 401"]
priority: P1
---

# TC-PROMO-2-62: Every admin endpoint returns 401 without a token

## Why

- Story AC; six separate endpoints, one behavior.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Body V from the create-valid-draft case.

## Steps

1. `GET /api/promotions?page=0&pageSize=20` with no Authorization header.
2. `GET /api/promotions/1` with no Authorization header.
3. `POST /api/promotions (body V)` with no Authorization header.
4. `PUT /api/promotions/5 (body V)` with no Authorization header.
5. `POST /api/promotions/5/publish` with no Authorization header.
6. `POST /api/promotions/5/end` with no Authorization header.

## Expected result

- Each of the six requests returns `401`.
- Promotion 5 is still a Draft and the promotion count is still 7.
