---
id: TC-PROMO-2-55
title: End on an Active promotion returns 204, expires it, sends the end event once and removes it from /active
type: happy
layer: functional
covers: ["AC: /end -> Expired, PromotionEndedIntegrationEvent once, drops out of /active", "Outputs: end 204"]
priority: P1
---

# TC-PROMO-2-55: End on an Active promotion returns 204, expires it, sends the end event once and removes it from /active

## Why

- Admin-ended flow; the end event is only sent for promotions that had started, so the case first creates and publishes one whose start event went out.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Promotion `{id}` created with body V (startsAt = now - 1 hour, endsAt = now + 7 days) and published, with `PromotionId` `{id}` start event recorded.

## Steps

1. `GET /api/promotions/active` anonymously and confirm `{id}` is present.
2. `POST /api/promotions/{id}/end` with the admin token.
3. `GET /api/promotions/{id}` with the admin token.
4. `GET /api/promotions/active` anonymously.
5. Wait 65 seconds and count `PromotionEndedIntegrationEvent` rows for `{id}`.

## Expected result

- End returns `204` with an empty body.
- The admin GET shows `effectiveStatus` `Expired`.
- `{id}` is no longer in `/active`.
- Exactly one `PromotionEndedIntegrationEvent` row exists for `{id}` and its `Content` has `PromotionId` `{id}`.
