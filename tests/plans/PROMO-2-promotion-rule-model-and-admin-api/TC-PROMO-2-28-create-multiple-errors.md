---
id: TC-PROMO-2-28
title: Several invalid fields are all reported in one 400 and nothing is saved
type: sad
sad-path: validation
layer: functional
covers: ["AC: 400 with an error naming each failing field", "Outputs: 400 ValidationProblem with field-level errors"]
priority: P1
---

# TC-PROMO-2-28: Several invalid fields are all reported in one 400 and nothing is saved

## Why

- The AC says the error names *each* failing field; a validator that stops at the first error would pass every single-field case.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Body that breaks four rules at once:

  ```json
  {
    "description": "20% off all hiking gear",
    "type": "PercentOff",
    "value": 0,
    "targets": [],
    "startsAt": "<now + 1 day>",
    "endsAt": "<same as startsAt>",
    "priority": 10,
    "isStackable": false,
    "requiresCoupon": false
  }
  ```

## Steps

1. `GET /api/promotions?page=0&pageSize=100` with the admin token and note the total count.
2. `POST /api/promotions` with the admin token and the body above.
3. `GET /api/promotions?page=0&pageSize=100` again.

## Expected result

- POST returns `400` and `errors` has exactly the keys `endsAt`, `value`, `targets` and `name`.
- The total count is unchanged.
