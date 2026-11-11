---
id: TC-PROMO-1-23
title: GET /api/promotions with a malformed token returns 401
type: sad
sad-path: auth
layer: functional
covers: ["Outputs: malformed token returns 401"]
priority: P1
---

# TC-PROMO-1-23: GET /api/promotions with a malformed token returns 401

## Why

- A garbage token must be rejected, not treated as anonymous; separate from the missing-token case because the validation path differs.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.

## Steps

1. `GET /api/promotions?api-version=1.0` with header `Authorization: Bearer not-a-jwt`.

## Expected result

- Status `401`.
- No promotion data in the body.
