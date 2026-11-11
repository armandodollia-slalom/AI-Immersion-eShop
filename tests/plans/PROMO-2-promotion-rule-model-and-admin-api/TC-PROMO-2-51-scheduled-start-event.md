---
id: TC-PROMO-2-51
title: A scheduled start event is published within 60s of startsAt
type: happy
layer: functional
covers: ["AC: Scheduled -> event published within 60s of startsAt", "Outputs: PromotionStartedIntegrationEvent sent when StartsAt passes"]
priority: P1
---

# TC-PROMO-2-51: A scheduled start event is published within 60s of startsAt

## Why

- The only timer-driven start behavior; needs real time, so it cannot be a cheaper layer.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Create a Draft with body V but `startsAt` = now + 10 seconds and `endsAt` = now + 1 day; call its id `{id}`.
- Publish it with `POST /api/promotions/{id}/publish`; record the response `effectiveStatus` (expected `Scheduled`).

## Steps

1. Poll `IntegrationEventLog` in `promotionsdb` every 5 seconds for `PromotionStartedIntegrationEvent` rows for `{id}`, up to 70 seconds after startsAt.
2. `GET /api/promotions/{id}` with the admin token.

## Expected result

- A single matching row appears no later than 60 seconds after `startsAt`, and not before `startsAt`.
- `effectiveStatus` is `Active` and the promotion is in `GET /api/promotions/active`.
