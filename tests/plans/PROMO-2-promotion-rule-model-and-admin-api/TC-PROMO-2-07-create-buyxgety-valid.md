---
id: TC-PROMO-2-07
title: Valid BuyXGetY ignores value and keeps both quantities
type: happy
layer: functional
covers: ["Inputs: Value ignored for BuyXGetY", "Inputs: BuyQuantity/GetQuantity both >= 1 for BuyXGetY"]
priority: P1
---

# TC-PROMO-2-07: Valid BuyXGetY ignores value and keeps both quantities

## Why

- BuyXGetY is the only type without a Value rule; a validator wrongly demanding it would block the type.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Body V with `type` BuyXGetY, `value` 55, `buyQuantity` 2, `getQuantity` 1:

  ```json
  {
    "name": "Fall Hiking Sale",
    "description": "20% off all hiking gear",
    "type": "BuyXGetY",
    "value": 55,
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
    "requiresCoupon": false,
    "buyQuantity": 2,
    "getQuantity": 1
  }
  ```

## Steps

1. `POST /api/promotions` with the admin token and the body above.

## Expected result

- Status `201`; `type` is `BuyXGetY`, `buyQuantity` is `2`, `getQuantity` is `1`.
- No error for `value` although 55 would be fine for PercentOff (the value is not validated for this type).
