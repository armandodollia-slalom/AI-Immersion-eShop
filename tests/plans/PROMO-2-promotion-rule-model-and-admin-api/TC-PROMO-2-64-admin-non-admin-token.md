---
id: TC-PROMO-2-64
title: A token without the admin role is forbidden on every admin endpoint
type: sad
sad-path: auth
layer: functional
covers: ["Errors: 401 or 403 when the caller isn't an admin"]
priority: P1
---

# TC-PROMO-2-64: A token without the admin role is forbidden on every admin endpoint

## Why

- Authenticated but not an admin is the main authorization risk (the Copilot and shoppers must not manage promotions).

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Non-admin token: user bob, scope `promotions`, no `admin` role.
- Body V from the create-valid-draft case.

## Steps

1. `GET /api/promotions?page=0&pageSize=20` with the non-admin token.
2. `GET /api/promotions/1` with the non-admin token.
3. `POST /api/promotions (body V)` with the non-admin token.
4. `PUT /api/promotions/5 (body V)` with the non-admin token.
5. `POST /api/promotions/5/publish` with the non-admin token.
6. `POST /api/promotions/5/end` with the non-admin token.

## Expected result

- Each of the six requests returns `403`.
- Promotion 5 is still a Draft and the promotion count is still 7.
