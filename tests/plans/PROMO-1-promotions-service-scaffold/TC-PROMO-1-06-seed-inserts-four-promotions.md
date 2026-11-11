---
id: TC-PROMO-1-06
title: Seeder inserts exactly the four seeded promotions
type: happy
layer: functional
covers: ["Outputs: seeder inserts exactly 4 promotions", "AC: seed data matches the table"]
priority: P1
---

# TC-PROMO-1-06: Seeder inserts exactly the four seeded promotions

## Why

- The seed table has per-row requirements (rule type, coupon-only, status, window); a single case asserts each row so a wrong type or window fails with a precise diff.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.

## Steps

1. Record `now` from the test `TimeProvider` at the first run.
2. Read all rows of `Promotions` ordered by `Id`.

## Expected result

- Exactly 4 rows.
- One row each of `Type` `PercentOff` with `RequiresCoupon = false`, `AmountOffOrder`, `BuyXGetY`, and one `PercentOff` with `RequiresCoupon = true`.
- All 4 have `Status = Published`.
- All 4 have `StartsAt` = first-run now minus 1 day (within 1 minute) and `EndsAt` at least first-run now plus 60 days.
