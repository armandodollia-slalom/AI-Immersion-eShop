---
id: TC-PROMO-1-24
title: GET /api/promotions with an expired token returns 401
type: sad
sad-path: auth
layer: functional
covers: ["Outputs: expired token returns 401"]
priority: P1
---

# TC-PROMO-1-24: GET /api/promotions with an expired token returns 401

## Why

- Lifetime validation is a separate failure from format validation.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.
- A token signed by the Identity signing key (or the test authority) for alice with scope `promotions` whose `exp` is 1 hour in the past.

## Steps

1. `GET /api/promotions?api-version=1.0` with header `Authorization: Bearer <expired token>`.

## Expected result

- Status `401`.
- No promotion data in the body.
