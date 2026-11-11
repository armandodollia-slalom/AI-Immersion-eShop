---
id: TC-PROMO-1-14
title: Each active promotion has the required fields
type: happy
layer: functional
covers: ["Outputs: each element has id, name, type, status, startsAt, endsAt, priority, requiresCoupon"]
priority: P1
---

# TC-PROMO-1-14: Each active promotion has the required fields

## Why

- PROMO-2 owns the final shape, but the story fixes this minimum; checking values rather than presence catches a type/status serialized as a number.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with an empty `promotionsdb` and seeding on (`Seeding__Disabled` not set), so the seeder has run once.

## Steps

1. `GET /api/promotions/active?api-version=1.0` anonymously.

## Expected result

- Every element has the properties `id`, `name`, `type`, `status`, `startsAt`, `endsAt`, `priority` and `requiresCoupon`.
- `type` values are the strings `PercentOff`, `AmountOffOrder`, `BuyXGetY`, `PercentOff`.
- `status` is `Published` for all.
- `requiresCoupon` is `true` for exactly one element and `false` for the other three.
- `startsAt` and `endsAt` parse as timestamps with `startsAt` < `endsAt`.
