---
id: TC-PROMO-3-32
title: 101 lines are rejected
type: sad
sad-path: validation
layer: functional
covers: ["Inputs: items 1-100 lines (just above the maximum)", "Outputs: 400 ValidationProblem"]
priority: P1
---

# TC-PROMO-3-32: 101 lines are rejected

## Why

- Just outside the upper boundary; paired with the 100-line case.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: 101 lines, product ids 1000 to 1100, type 9, brand 9, unit price 1.00, quantity 1.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   Body: `items` is the 101 lines described in the preconditions.

## Expected result

- Status `400` with a ValidationProblem body (`title` `One or more validation errors occurred.`).
- `errors` contains key `items`.
- No `subtotal`, `lines` or `appliedPromotions` is returned.
