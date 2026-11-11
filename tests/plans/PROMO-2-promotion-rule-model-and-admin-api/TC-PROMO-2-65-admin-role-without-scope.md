---
id: TC-PROMO-2-65
title: A token with the admin role but without the promotions scope is rejected
type: sad
sad-path: auth
layer: functional
covers: ["Errors: 401 or 403 when the caller isn't an admin"]
priority: P2
---

# TC-PROMO-2-65: A token with the admin role but without the promotions scope is rejected

## Why

- Wrong-scope case; admin access needs both the scope and the role.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Token: user alice, role `admin`, scope `openid` only (no `promotions`).

## Steps

1. `GET /api/promotions?page=0&pageSize=20` with this token.

## Expected result

- Status `403`.
