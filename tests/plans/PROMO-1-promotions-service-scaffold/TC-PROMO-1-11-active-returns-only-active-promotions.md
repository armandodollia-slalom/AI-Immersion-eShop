---
id: TC-PROMO-1-11
title: GET /active returns the four seeded promotions and no inactive ones
type: happy
layer: functional
covers: ["Outputs: active promotion definition", "Outputs: coupon-only promotions count as active", "AC: exactly the 4 seeded promotions"]
priority: P1
---

# TC-PROMO-1-11: GET /active returns the four seeded promotions and no inactive ones

## Why

- Core filter rule: Published and inside the window. The three extras each break one condition (status, end, start), so a filter that drops any one condition fails here.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.
- Plus three extra promotions inserted directly into `promotionsdb`: (a) `Status = Draft`, `StartsAt = now - 1 day`, `EndsAt = now + 30 days`; (b) `Status = Published`, `StartsAt = now - 10 days`, `EndsAt = now - 1 day` (ended yesterday); (c) `Status = Published`, `StartsAt = now + 1 day`, `EndsAt = now + 30 days` (starts tomorrow).

## Steps

1. `GET /api/promotions/active?api-version=1.0` without an Authorization header.

## Expected result

- Status `200`, JSON array of length 4.
- The ids are exactly those of the 4 seeded promotions, including the coupon-only one.
- The Draft, ended-yesterday and starts-tomorrow promotions are absent.
