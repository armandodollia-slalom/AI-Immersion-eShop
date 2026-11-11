---
id: TC-PROMO-1-15
title: GET /active returns 200 and an empty array when nothing is active
type: happy
layer: functional
covers: ["Outputs: when no promotion is active it returns 200 with []"]
priority: P1
---

# TC-PROMO-1-15: GET /active returns 200 and an empty array when nothing is active

## Why

- An empty result must not be 404 or null; callers iterate the body.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.
- All 4 seeded promotions updated to `Status = Draft`.

## Steps

1. `GET /api/promotions/active?api-version=1.0` anonymously.

## Expected result

- Status `200`.
- Body is exactly `[]`.
