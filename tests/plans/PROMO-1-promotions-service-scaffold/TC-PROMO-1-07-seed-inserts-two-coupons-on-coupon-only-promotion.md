---
id: TC-PROMO-1-07
title: Seeder inserts coupons FALL10 and WELCOME5 on the coupon-only promotion
type: happy
layer: functional
covers: ["Outputs: 2 coupons FALL10 and WELCOME5", "Outputs: no redemptions"]
priority: P1
---

# TC-PROMO-1-07: Seeder inserts coupons FALL10 and WELCOME5 on the coupon-only promotion

## Why

- Later stories (PROMO-4) rely on these codes belonging to the coupon-only promotion; separate from the promotion rows because it exercises the foreign key and the empty redemption table.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.

## Steps

1. Read all rows of `Coupons` joined to `Promotions`.
2. Count rows of `CouponRedemptions`.

## Expected result

- Exactly 2 coupon rows with codes `FALL10` and `WELCOME5`.
- Both reference the promotion with `RequiresCoupon = true`.
- `CouponRedemptions` has 0 rows.
