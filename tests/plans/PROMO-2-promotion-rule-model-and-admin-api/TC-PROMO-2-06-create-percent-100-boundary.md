---
id: TC-PROMO-2-06
title: PercentOff value 100 is accepted
type: happy
layer: functional
covers: ["Inputs: PercentOff 0 < v <= 100 (upper boundary inside)"]
priority: P1
---

# TC-PROMO-2-06: PercentOff value 100 is accepted

## Why

- Just-inside upper boundary; paired with the 100.01 rejection.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Body V with `value` 100:

  ```json
  {
    "name": "Fall Hiking Sale",
    "description": "20% off all hiking gear",
    "type": "PercentOff",
    "value": 100,
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

## Steps

1. `POST /api/promotions` with the admin token and the body above.

## Expected result

- Status `201` and `value` `100`.
