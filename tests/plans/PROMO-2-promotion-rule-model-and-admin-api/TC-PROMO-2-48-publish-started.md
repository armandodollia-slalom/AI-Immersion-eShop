---
id: TC-PROMO-2-48
title: Publishing a Draft that has already started makes it Active and sends the start event exactly once
type: happy
layer: functional
covers: ["Technical Notes: worker records which events it sent", "AC: publish with startsAt in the past -> Active and PromotionStartedIntegrationEvent once", "Endpoints: publish"]
priority: P1
---

# TC-PROMO-2-48: Publishing a Draft that has already started makes it Active and sends the start event once

## Why

- Core publish contract plus the outbox; the `at once` clause of the event rules. Waiting three worker cycles also proves the event is not repeated by later cycles (a worker without sent-tracking would resend every 30s).

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Create a Draft with body V but `startsAt` = now - 1 hour and `endsAt` = now + 7 days; call its id `{id}`.
- Note the count of `IntegrationEventLog` rows whose `EventTypeName` ends with `PromotionStartedIntegrationEvent` and whose content has `PromotionId` `{id}` (expected 0).

## Steps

1. `POST /api/promotions/{id}/publish` with the admin token.
2. Wait 95 seconds (three worker cycles).
3. Count the matching `IntegrationEventLog` rows again.

## Expected result

- Publish returns `200` with `status` `Published` and `effectiveStatus` `Active`.
- After the 95-second wait there is still exactly one `PromotionStartedIntegrationEvent` row for `{id}`.
