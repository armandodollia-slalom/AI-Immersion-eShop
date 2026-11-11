---
id: TC-PROMO-1-19
title: GET /active returns the same result with a valid token
type: happy
layer: functional
covers: ["Outputs: ignores any bearer token sent with it"]
priority: P1
---

# TC-PROMO-1-19: GET /active returns the same result with a valid token

## Why

- Confirms a valid token neither changes the result nor causes per-user filtering.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.
- Access token for alice (password `Pass123$`) issued by Identity.API for client `webapp` with scope `promotions`.

## Steps

1. `GET /api/promotions/active?api-version=1.0` with header `Authorization: Bearer <alice token>`.
2. `GET /api/promotions/active?api-version=1.0` anonymously.

## Expected result

- Both return `200`.
- Both bodies are identical.
