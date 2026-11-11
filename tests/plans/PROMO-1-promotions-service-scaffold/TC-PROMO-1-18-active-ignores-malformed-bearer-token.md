---
id: TC-PROMO-1-18
title: GET /active ignores a malformed bearer token
type: sad
sad-path: auth
layer: functional
covers: ["Outputs: ignores any bearer token sent with it", "AC: malformed bearer token still returns 200"]
priority: P1
---

# TC-PROMO-1-18: GET /active ignores a malformed bearer token

## Why

- Anonymous endpoints can still fail with 401 when the auth middleware validates a bad token first; this protects anonymous callers whose client sends a stale header.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.
- Plus three extra promotions inserted directly into `promotionsdb`: (a) `Status = Draft`, `StartsAt = now - 1 day`, `EndsAt = now + 30 days`; (b) `Status = Published`, `StartsAt = now - 10 days`, `EndsAt = now - 1 day` (ended yesterday); (c) `Status = Published`, `StartsAt = now + 1 day`, `EndsAt = now + 30 days` (starts tomorrow).

## Steps

1. `GET /api/promotions/active?api-version=1.0` with header `Authorization: Bearer not-a-jwt`.

## Expected result

- Status `200`.
- Same 4 promotions in the same order as the anonymous call.
