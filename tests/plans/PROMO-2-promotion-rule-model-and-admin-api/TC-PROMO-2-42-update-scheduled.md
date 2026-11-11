---
id: TC-PROMO-2-42
title: PUT on a Scheduled promotion updates it and returns 200
type: happy
layer: functional
covers: ["Endpoints: PUT while Scheduled"]
priority: P1
---

# TC-PROMO-2-42: PUT on a Scheduled promotion updates it and returns 200

## Why

- The other editable state; seed 7 is Scheduled.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Update body U = body V with `name` `Fall Hiking Sale v2` and `value` 25:

  ```json
  {
    "name": "Fall Hiking Sale v2",
    "description": "20% off all hiking gear",
    "type": "PercentOff",
    "value": 25,
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
- Use promotion 7 (Published, starts tomorrow); U uses startsAt = now + 2 days and endsAt = now + 9 days.

## Steps

1. `PUT /api/promotions/7` with the admin token and body U.

## Expected result

- Status `200` with `name` `Fall Hiking Sale v2`, `status` `Published`, `effectiveStatus` `Scheduled`.
