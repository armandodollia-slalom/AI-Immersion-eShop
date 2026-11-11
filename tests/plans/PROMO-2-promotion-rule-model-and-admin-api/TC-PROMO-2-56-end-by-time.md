---
id: TC-PROMO-2-56
title: An Active promotion that reaches endsAt expires and sends the end event within 60s
type: happy
layer: functional
covers: ["AC: Active promotion reaches endsAt -> Expired, event once, out of /active", "Outputs: PromotionEndedIntegrationEvent sent when EndsAt passes"]
priority: P1
---

# TC-PROMO-2-56: An Active promotion that reaches endsAt expires and sends the end event within 60s

## Why

- Timer-driven end; needs real time.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Create body V with `startsAt` = now - 1 hour and `endsAt` = now + 10 seconds; call its id `{id}`; publish it.

## Steps

1. Poll `GET /api/promotions/active` anonymously every 5 seconds for 20 seconds.
2. Poll `IntegrationEventLog` every 5 seconds for `PromotionEndedIntegrationEvent` rows for `{id}`, up to 70 seconds after endsAt.
3. `GET /api/promotions/{id}` with the admin token.

## Expected result

- `{id}` disappears from `/active` at or after endsAt and not before.
- Exactly one end event row appears no later than 60 seconds after endsAt, and stays at one after a further 35 seconds.
- `effectiveStatus` is `Expired`.
