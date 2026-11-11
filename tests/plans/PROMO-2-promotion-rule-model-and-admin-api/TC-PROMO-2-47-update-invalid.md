---
id: TC-PROMO-2-47
title: PUT with an invalid body on a Draft returns 400 and changes nothing
type: sad
sad-path: validation
layer: functional
covers: ["Outputs: 400 for every rule in the table (also on update)"]
priority: P1
---

# TC-PROMO-2-47: PUT with an invalid body on a Draft returns 400 and changes nothing

## Why

- Validation must apply to edits as well as creates; otherwise a Draft can be made invalid.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Invalid body: V with `value` 0.

  ```json
  {
    "name": "Fall Hiking Sale",
    "description": "20% off all hiking gear",
    "type": "PercentOff",
    "value": 0,
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
- Create a Draft with the valid body V; call its id `{id}`.

## Steps

1. `PUT /api/promotions/{id}` with the admin token and the invalid body.
2. `GET /api/promotions/{id}` with the admin token.

## Expected result

- PUT returns `400` with `errors` containing the key `value`.
- GET still shows `value` `20`.
