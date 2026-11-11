---
id: TC-PROMO-3-33
title: Exactly 100 lines are accepted
type: happy
layer: functional
covers: ["Inputs: items 1-100 lines (inside the maximum)"]
priority: P1
---

# TC-PROMO-3-33: Exactly 100 lines are accepted

## Why

- Just inside the upper boundary: protects against an off-by-one in the line limit.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: 100 lines, product ids 1000 to 1099, type 9, brand 9, unit price 1.00, quantity 1.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   Body: `items` is the 100 lines described in the preconditions.

## Expected result

- Status `200`.
- `subtotal` 100.00, `totalDiscount` 0.00, `total` 100.00; `lines` has 100 entries in request order.
- `nextThreshold` is `{promotionId 3, minOrderTotal 150.00, amountRemaining 50.00, reward 10.00}`.
