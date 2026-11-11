---
id: TC-PROMO-3-21
title: A Draft promotion is never applied
type: sad
sad-path: validation
layer: functional
covers: ["AC: promotion is Draft -> never applied", "Algorithm step 1 EffectiveStatus = Active"]
priority: P1
---

# TC-PROMO-3-21: A Draft promotion is never applied

## Why

- Draft is the main way an unfinished promotion could leak to shoppers; its date window is open so only the status keeps it out.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Promotion 5 (Draft, window open) is in the seed; it targets All with PercentOff 5, so a cart of product 99 would get 5.00 off per 100.00 if it were wrongly applied.
- Cart: product 99 (type 9, brand 9), unit price 100.00, quantity 1.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "items": [
      {
        "productId": 99,
        "catalogTypeId": 9,
        "catalogBrandId": 9,
        "unitPrice": 100.0,
        "quantity": 1
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `subtotal` 100.00, `totalDiscount` 0.00, `total` 100.00; the line has `discount 0.00` and `appliedPromotionIds []`.
- `appliedPromotions` is empty (promotion 5 is not listed).
