---
id: TC-PROMO-1-22
title: GET /api/promotions without a token returns 401
type: sad
sad-path: auth
layer: functional
covers: ["Outputs: without a token returns 401", "AC: called without a token"]
priority: P1
---

# TC-PROMO-1-22: GET /api/promotions without a token returns 401

## Why

- Protects the temporary list endpoint from anonymous access.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.

## Steps

1. `GET /api/promotions?api-version=1.0` with no Authorization header.

## Expected result

- Status `401`.
- No promotion data in the body.
