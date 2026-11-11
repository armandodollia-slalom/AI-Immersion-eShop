---
id: TC-PROMO-2-59
title: Each /active element has the public shape
type: happy
layer: functional
covers: ["Outputs: GET /active public shape"]
priority: P1
---

# TC-PROMO-2-59: Each /active element has the public shape

## Why

- The storefront reads these fields; values catch enums serialised as numbers.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-1` scenario loaded (promotions 1-7: 1-3 Active without coupon, 4 Active coupon-only, 5 Draft, 6 Published and ended yesterday, 7 Published starting tomorrow; with targets All, Type 3 and Product 40 among them) and the worker running with its normal 30s period. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so results do not depend on the order cases run in.
- No Authorization header.

## Steps

1. `GET /api/promotions/active` with no token.

## Expected result

- Element with id 1 is `{id 1, name "Fall Hiking Sale", description "20% off all hiking gear", type "PercentOff", value 20, badgeLabel "-20%", targets [{scope "Type", targetId 3}], endsAt <stored value>, priority 10, requiresCoupon false}`.
- Element with id 2 has `type` `BuyXGetY` and `badgeLabel` `Buy 2 Get 1`.
- Every element has `id`, `name`, `description`, `type`, `value`, `badgeLabel`, `targets`, `endsAt`, `priority`, `requiresCoupon`.
