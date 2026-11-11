---
id: TC-PROMO-2-02
title: Omitted priority, isStackable and requiresCoupon default to 0, false, false
type: happy
layer: functional
covers: ["Inputs: Priority default 0", "Inputs: IsStackable default false", "Inputs: RequiresCoupon default false"]
priority: P1
---

# TC-PROMO-2-02: Omitted priority, isStackable and requiresCoupon default to 0, false, false

## Why

- Three defaults in the field table; a separate case because the main case sets them explicitly.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Body V without `priority`, `isStackable` and `requiresCoupon`:

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
    "endsAt": "<now + 8 days>"
  }
  ```

## Steps

1. `POST /api/promotions` with the admin token and the body above.
2. `GET /api/promotions/{id}` with the admin token for the returned id.

## Expected result

- POST returns `201`; the POST body and the GET body both have `priority` `0`, `isStackable` `false` and `requiresCoupon` `false`.
