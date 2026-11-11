---
id: TC-PROMO-2-67
title: Publishing a promotion that is not a Draft returns 409 and changes nothing
type: sad
sad-path: conflict
layer: functional
covers: ["Implementation Notes: /publish on a non-Draft returns 409", "Endpoints: publish changes Draft to Published"]
priority: P1
---

# TC-PROMO-2-67: Publishing a promotion that is not a Draft returns 409 and changes nothing

## Why

- Publish is defined only as Draft to Published; the implementation notes state `409` for any other state. Without it a repeated publish could re-send the start event. Functional layer because it needs the real state and the outbox.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow). All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Note the number of `IntegrationEventLog` rows for promotion 1 before the call.

## Steps

1. `POST /api/promotions/1/publish` with the admin token.
2. `GET /api/promotions/1` with the admin token.

## Expected result

- Step 1 returns `409`.
- Step 2 returns `200` with `status` `Published`, `effectiveStatus` `Active` and the same field values as before the call.
- The count of `IntegrationEventLog` rows for promotion 1 is unchanged.
