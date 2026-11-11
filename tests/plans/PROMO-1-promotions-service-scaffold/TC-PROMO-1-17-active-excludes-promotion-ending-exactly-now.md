---
id: TC-PROMO-1-17
title: A promotion with EndsAt equal to now is not active
type: sad
sad-path: boundary
layer: functional
covers: ["Outputs: now < EndsAt"]
priority: P1
---

# TC-PROMO-1-17: A promotion with EndsAt equal to now is not active

## Why

- Upper boundary is exclusive; an off-by-one (`<=`) would keep applying a promotion after it ended. Uses a fake `TimeProvider`.

## Preconditions

- Promotions.API host with the `TimeProvider` replaced by a fake fixed at `T`, seeding off.
- One `Published` promotion with `StartsAt = T - 10 days` and `EndsAt = T`.
- One `Published` promotion with `StartsAt = T - 10 days` and `EndsAt = T + 1 second`.

## Steps

1. `GET /api/promotions/active?api-version=1.0` anonymously.

## Expected result

- Status `200`, array of length 1.
- The one returned is the promotion ending at `T + 1 second`.
