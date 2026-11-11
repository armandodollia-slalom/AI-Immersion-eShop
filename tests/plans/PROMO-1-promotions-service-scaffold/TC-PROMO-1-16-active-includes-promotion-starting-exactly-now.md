---
id: TC-PROMO-1-16
title: A promotion with StartsAt equal to now is active
type: sad
sad-path: boundary
layer: functional
covers: ["Outputs: StartsAt <= now"]
priority: P1
---

# TC-PROMO-1-16: A promotion with StartsAt equal to now is active

## Why

- Lower boundary of the window; an off-by-one (`<`) would hide a promotion at the instant it starts. Uses a fake `TimeProvider` so the instant is exact.

## Preconditions

- Promotions.API host with the `TimeProvider` replaced by a fake fixed at `T`, seeding off.
- One `Published` promotion with `StartsAt = T` and `EndsAt = T + 10 days`.

## Steps

1. `GET /api/promotions/active?api-version=1.0` anonymously.

## Expected result

- Status `200`, array of length 1 containing that promotion.
