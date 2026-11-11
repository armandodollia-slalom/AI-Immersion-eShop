---
id: TC-PROMO-1-08
title: Restarting against the same database keeps 4 promotions and 2 coupons
type: happy
layer: functional
covers: ["AC: starts again against the same database", "Outputs: seeder idempotent"]
priority: P1
---

# TC-PROMO-1-08: Restarting against the same database keeps 4 promotions and 2 coupons

## Why

- Aspire restarts the service routinely; a seeder that appended on every start would duplicate promotions and double-count them in `/active`.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.

## Steps

1. Stop Promotions.API without touching the database.
2. Start Promotions.API again against the same `promotionsdb` and wait until startup completes.
3. Count rows of `Promotions` and `Coupons`.

## Expected result

- `Promotions` has exactly 4 rows with the same ids as after the first run.
- `Coupons` has exactly 2 rows.
- Startup completed without error.
