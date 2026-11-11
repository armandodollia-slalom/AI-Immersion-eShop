---
id: TC-PROMO-2-35
title: Paging splits the promotions into pages of the requested size
type: happy
layer: functional
covers: ["Endpoints: list paged (page, pageSize)"]
priority: P1
---

# TC-PROMO-2-35: Paging splits the promotions into pages of the requested size

## Why

- Paging parameters are part of the endpoint contract.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.

## Steps

1. `GET /api/promotions?page=0&pageSize=3` with the admin token.
2. `GET /api/promotions?page=1&pageSize=3` with the admin token.
3. `GET /api/promotions?page=2&pageSize=3` with the admin token.

## Expected result

- All three return `200`; the pages hold 3, 3 and 1 promotions.
- The ids on the three pages together are exactly 1 to 7, each once, with no id repeated across pages.
- The story defines no ordering or paging envelope, so the case asserts only the slice contents and not fields such as `page`, `pageSize` or `total`.
