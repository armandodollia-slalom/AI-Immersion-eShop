---
id: TC-PROMO-2-41
title: PUT on a Draft promotion updates it and returns 200
type: happy
layer: functional
covers: ["Endpoints: PUT while Draft", "Outputs: PUT 200 with full promotion"]
priority: P1
---

# TC-PROMO-2-41: PUT on a Draft promotion updates it and returns 200

## Why

- Primary edit path; Draft is one of the two editable states.

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
- Create a Draft with `POST /api/promotions` and body V; call its id `{id}`.

## Steps

1. `PUT /api/promotions/{id}` with the admin token and body U.
2. `GET /api/promotions/{id}` with the admin token.

## Expected result

- PUT returns `200` with `name` `Fall Hiking Sale v2`, `value` `25`, `status` `Draft`, `effectiveStatus` `Draft`.
- GET returns the same name and value.
