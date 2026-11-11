---
id: TC-PROMO-2-01
title: Valid promotion is created as Draft with 201, Location and the full body
type: happy
layer: functional
covers: ["Outputs: POST 201 + Location + full promotion", "AC: valid promotion saved as Draft"]
priority: P1
---

# TC-PROMO-2-01: Valid promotion is created as Draft with 201, Location and the full body

## Why

- Core create contract: protects status Draft, Location header, the status/effectiveStatus fields and the 'no event on create' rule. Functional because it needs Postgres and the outbox table.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Body V:

  ```json
  {
    "name": "Fall Hiking Sale",
    "description": "20% off all hiking gear",
    "type": "PercentOff",
    "value": 20,
    "targets": [
      {
        "scope": "Type",
        "targetId": 3
      }
    ],
    "startsAt": "<now + 1 day>",
    "endsAt": "<now + 8 days>",
    "priority": 10,
    "isStackable": false,
    "requiresCoupon": false
  }
  ```
- Note the row count of `IntegrationEventLog` in `promotionsdb`.

## Steps

1. `POST /api/promotions` with the admin token and body V.

## Expected result

- Status `201 Created`; header `Location` is `/api/promotions/{id}` where `{id}` is the `id` in the body and is greater than 7.
- Body echoes name `Fall Hiking Sale`, description `20% off all hiking gear`, type `PercentOff`, value `20`, one target `{scope: Type, targetId: 3}`, priority `10`, isStackable `false`, requiresCoupon `false`, and the sent startsAt and endsAt.
- Body `status` is `Draft` and `effectiveStatus` is `Draft`.
- `IntegrationEventLog` has the same row count as before (no event published).
