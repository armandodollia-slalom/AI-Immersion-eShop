---
id: TC-PROMO-1-05
title: Startup migration creates the five tables on an empty database
type: happy
layer: functional
covers: ["Outputs: EF migration creates tables", "AC: five tables exist"]
priority: P1
---

# TC-PROMO-1-05: Startup migration creates the five tables on an empty database

## Why

- The migration is the first thing every later promotion story depends on; checking `information_schema` is the cheapest way to prove all five tables, including the shared `IntegrationEventLog`, exist. Functional layer per Test scope (real Postgres).

## Preconditions

- Empty `promotionsdb` on real Postgres (no tables).

## Steps

1. Start Promotions.API against the empty database and wait until startup completes.
2. Query `information_schema.tables` for schema `public`.

## Expected result

- Tables `Promotions`, `PromotionTargets`, `Coupons`, `CouponRedemptions` and `IntegrationEventLog` all exist.
- `__EFMigrationsHistory` contains the `Initial` migration row.
