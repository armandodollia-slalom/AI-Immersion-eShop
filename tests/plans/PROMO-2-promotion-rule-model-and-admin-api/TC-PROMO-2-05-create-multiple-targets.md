---
id: TC-PROMO-2-05
title: Several targets of different scopes are all stored and returned
type: happy
layer: functional
covers: ["Inputs: Targets at least 1; Scope All, Brand, Type or Product"]
priority: P1
---

# TC-PROMO-2-05: Several targets of different scopes are all stored and returned

## Why

- Targets is a collection; a regression storing only the first target would break every multi-target campaign.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Body V with `targets` = Brand 2, Type 3, Product 40:

  ```json
  {
    "name": "Fall Hiking Sale",
    "description": "20% off all hiking gear",
    "type": "PercentOff",
    "value": 20,
    "targets": [
      {
        "scope": "Brand",
        "targetId": 2
      },
      {
        "scope": "Type",
        "targetId": 3
      },
      {
        "scope": "Product",
        "targetId": 40
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
2. `GET /api/promotions/{id}` with the admin token.

## Expected result

- Both responses list exactly three targets: `{Brand,2}`, `{Type,3}`, `{Product,40}`.
