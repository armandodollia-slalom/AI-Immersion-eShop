---
id: TC-PROMO-1-12
title: GET /active orders promotions by priority descending
type: happy
layer: functional
covers: ["Outputs: ordered by priority descending"]
priority: P1
---

# TC-PROMO-1-12: GET /active orders promotions by priority descending

## Why

- Order is part of the contract that PROMO-3 consumes; split from the filter case so an ordering bug does not hide behind a membership assertion.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.
- Seeded priorities as the seeder sets them: 15% off 10, $20 off 8, buy 2 get 1 6, coupon-only 10% off 5.

## Steps

1. `GET /api/promotions/active?api-version=1.0` anonymously.

## Expected result

- Status `200`.
- The `priority` values in order are `10, 8, 6, 5`.
- Names in order: percent-off, amount-off-order, buy-X-get-Y, coupon-only.
