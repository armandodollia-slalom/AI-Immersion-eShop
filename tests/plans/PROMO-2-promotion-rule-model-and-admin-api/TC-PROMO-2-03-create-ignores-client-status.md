---
id: TC-PROMO-2-03
title: A status sent in the create body is ignored and the promotion is saved as Draft
type: happy
layer: functional
covers: ["Endpoints: Create (always as Draft)"]
priority: P1
---

# TC-PROMO-2-03: A status sent in the create body is ignored and the promotion is saved as Draft

## Why

- The Copilot (PROMO-7) relies on create never yielding a published promotion; a client must not be able to bypass that with a `status` field.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- Admin token: user alice, scope `promotions`, role `admin`.
- Body V plus the extra property `"status": "Published"`:

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
    "endsAt": "<now + 8 days>",
    "priority": 10,
    "isStackable": false,
    "requiresCoupon": false,
    "status": "Published"
  }
  ```

## Steps

1. `POST /api/promotions` with the admin token and the body above.
2. `GET /api/promotions/active` anonymously.

## Expected result

- POST returns `201` with `status` `Draft` and `effectiveStatus` `Draft`.
- The new id is not in the `/active` response.
