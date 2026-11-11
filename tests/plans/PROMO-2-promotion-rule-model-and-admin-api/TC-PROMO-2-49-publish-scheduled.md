---
id: TC-PROMO-2-49
title: Publishing a Draft with a future start makes it Scheduled and sends no event yet
type: happy
layer: functional
covers: ["AC: publish with startsAt in the future -> Scheduled"]
priority: P1
---

# TC-PROMO-2-49: Publishing a Draft with a future start makes it Scheduled and sends no event yet

## Why

- Scheduled branch of publish; the event must not go out before the start.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Create a Draft with body V (startsAt = now + 1 day); call its id `{id}`.

## Steps

1. `POST /api/promotions/{id}/publish` with the admin token.
2. Wait 35 seconds (one worker cycle).
3. Count `PromotionStartedIntegrationEvent` rows in `IntegrationEventLog` for `{id}`.

## Expected result

- Publish returns `200` with `status` `Published` and `effectiveStatus` `Scheduled`.
- The count is 0.
- `GET /api/promotions/active` anonymously does not include `{id}`.
