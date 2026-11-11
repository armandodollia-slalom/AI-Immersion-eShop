---
id: TC-PROMO-2-53
title: The start event carries id, name, description, badge label, end and targets
type: happy
layer: functional
covers: ["Outputs: PromotionStartedIntegrationEvent { PromotionId, Name, Description, BadgeLabel, EndsAt, Targets[] }"]
priority: P1
---

# TC-PROMO-2-53: The start event carries id, name, description, badge label, end and targets

## Why

- Downstream stories (PROMO-6, PROMO-7) consume this payload; field names and values are the contract.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Promotion `{id}` created with body V (startsAt = now - 1 hour, endsAt = now + 7 days, targets `[{Type,3}]`) and published.

## Steps

1. Read the `Content` JSON of the `PromotionStartedIntegrationEvent` row for `{id}` in `IntegrationEventLog`.

## Expected result

- `PromotionId` = `{id}`, `Name` = `Fall Hiking Sale`, `Description` = `20% off all hiking gear`, `BadgeLabel` = `-20%`, `EndsAt` equals the stored endsAt, `Targets` has one element `{Scope: Type, TargetId: 3}`.
