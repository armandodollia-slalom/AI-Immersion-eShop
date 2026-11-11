---
id: TC-PROMO-2-04
title: A target with scope All and null targetId is accepted
type: happy
layer: functional
covers: ["Inputs: Targets TargetId null only when Scope = All"]
priority: P1
---

# TC-PROMO-2-04: A target with scope All and null targetId is accepted

## Why

- Positive side of the target rule; the sad cases only prove rejection.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Body V with `targets` = `[{"scope": "All", "targetId": null}]`:

  ```json
  {
    "name": "Fall Hiking Sale",
    "description": "20% off all hiking gear",
    "type": "PercentOff",
    "value": 20,
    "targets": [
      {
        "scope": "All",
        "targetId": null
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

- Status `201`; `targets` in the response is exactly one element with `scope` `All` and `targetId` `null`.
