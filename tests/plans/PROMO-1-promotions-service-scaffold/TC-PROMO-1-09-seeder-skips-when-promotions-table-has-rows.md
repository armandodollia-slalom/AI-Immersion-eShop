---
id: TC-PROMO-1-09
title: Seeder inserts nothing when Promotions already has a row
type: sad
sad-path: conflict
layer: functional
covers: ["Outputs: if the Promotions table already has any row, the seeder inserts nothing"]
priority: P2
---

# TC-PROMO-1-09: Seeder inserts nothing when Promotions already has a row

## Why

- Distinct from a plain restart: here the existing row is not seed data, so it proves the guard checks any row, not a count of 4.

## Preconditions

- Real Postgres `promotionsdb` migrated (five tables) with exactly one `Promotions` row (`Status = Draft`, name `Custom`) and no coupons.

## Steps

1. Start Promotions.API with seeding on and wait until startup completes.
2. Count rows of `Promotions` and `Coupons`.

## Expected result

- `Promotions` has exactly 1 row, the `Custom` one.
- `Coupons` has 0 rows.
