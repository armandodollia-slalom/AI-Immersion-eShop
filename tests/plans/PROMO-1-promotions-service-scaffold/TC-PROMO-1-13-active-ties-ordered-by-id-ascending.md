---
id: TC-PROMO-1-13
title: Promotions with equal priority are ordered by id ascending
type: happy
layer: functional
covers: ["Outputs: then id ascending"]
priority: P1
---

# TC-PROMO-1-13: Promotions with equal priority are ordered by id ascending

## Why

- The seeded priorities are all distinct, so the tie-break needs its own data; without it the order is nondeterministic across runs.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.
- Two more `Published` promotions inserted with `StartsAt = now - 1 day`, `EndsAt = now + 30 days`, `Priority = 100`, the first inserted with the higher `Id` (insert order reversed relative to id).

## Steps

1. `GET /api/promotions/active?api-version=1.0` anonymously.

## Expected result

- Status `200`, array of length 6.
- The first two elements both have `priority` 100 and the one with the lower `id` is first.
- The remaining 4 follow in `priority` descending order.
