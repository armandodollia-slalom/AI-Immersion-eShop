---
id: TC-PROMO-2-54
title: Outbox entries reach the Published state after sending
type: happy
layer: functional
covers: ["Outputs: events published through the outbox (IntegrationEventLogEF)"]
priority: P1
---

# TC-PROMO-2-54: Outbox entries reach the Published state after sending

## Why

- Proves the event goes through the outbox and is actually dispatched to the bus, not just inserted.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- The start event row from the publish-started case exists.

## Steps

1. Read the `State` and `TimesSent` of that row in `IntegrationEventLog` 10 seconds after it appears.

## Expected result

- `State` is the Published value (2) and `TimesSent` is 1.
