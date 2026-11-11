---
id: TC-PROMO-2-23
title: All target with a targetId is rejected
type: sad
sad-path: validation
layer: functional
covers: ["Inputs: TargetId null only when Scope = All"]
priority: P1
---

# TC-PROMO-2-23: All target with a targetId is rejected

## Why

- Converse of the rule: TargetId null *only* when scope is All.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Body V is the valid PercentOff body below; this case changes only: `targets` = `[{"scope":"All","targetId":5}]`.

  ```json
  {
    "name": "Fall Hiking Sale",
    "description": "20% off all hiking gear",
    "type": "PercentOff",
    "value": 20,
    "targets": [
      {
        "scope": "All",
        "targetId": 5
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

1. `GET /api/promotions?page=0&pageSize=100` with the admin token and note the total count.
2. `POST /api/promotions` with the admin token and body V with the change above.
3. `GET /api/promotions?page=0&pageSize=100` again.

## Expected result

- The POST returns `400` with a ValidationProblem body whose `errors` has the key `targets`.
- No other field is reported as failing.
- The second list has the same total count as the first (nothing saved) and the response has no `Location` header.
