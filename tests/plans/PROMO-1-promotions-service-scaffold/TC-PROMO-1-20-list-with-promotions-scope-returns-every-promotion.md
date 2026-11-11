---
id: TC-PROMO-1-20
title: GET /api/promotions with a promotions-scope token returns every promotion
type: happy
layer: functional
covers: ["Outputs: GET /api/promotions returns 200 with every promotion, active or not"]
priority: P1
---

# TC-PROMO-1-20: GET /api/promotions with a promotions-scope token returns every promotion

## Why

- Distinguishes the admin-style list from `/active`: inactive rows must be included. Functional layer because the token is validated against a real Identity.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.
- Plus three extra promotions inserted directly into `promotionsdb`: (a) `Status = Draft`, `StartsAt = now - 1 day`, `EndsAt = now + 30 days`; (b) `Status = Published`, `StartsAt = now - 10 days`, `EndsAt = now - 1 day` (ended yesterday); (c) `Status = Published`, `StartsAt = now + 1 day`, `EndsAt = now + 30 days` (starts tomorrow).
- Access token for alice (password `Pass123$`) issued by Identity.API for client `webapp` with scope `promotions`.

## Steps

1. `GET /api/promotions?api-version=1.0` with header `Authorization: Bearer <alice token>`.

## Expected result

- Status `200`, JSON array of length 7.
- It contains the 4 seeded promotions plus the Draft, the ended-yesterday and the starts-tomorrow promotion.
