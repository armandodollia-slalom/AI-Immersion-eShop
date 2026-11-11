---
id: TC-PROMO-3-04
title: Product 40 with quantity 5 still gets only 1 free unit
type: happy
layer: functional
covers: ["AC: quantity 5 -> still 1 free", "Algorithm step 3 floor(quantity / (buy + get))"]
priority: P1
---

# TC-PROMO-3-04: Product 40 with quantity 5 still gets only 1 free unit

## Why

- Guards the floor: a rounding-up or proportional implementation would give 2 free units at quantity 5.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: product 40 (type 1, brand 5), unit price 15.00, quantity 5.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "items": [
      {
        "productId": 40,
        "catalogTypeId": 1,
        "catalogBrandId": 5,
        "unitPrice": 15.0,
        "quantity": 5
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `subtotal` 75.00, `totalDiscount` 15.00, `total` 60.00.
- The line is `{productId 40, lineTotal 75.00, discount 15.00, appliedPromotionIds [2]}`.
- `appliedPromotions` is exactly `[{id 2, name "Buy 2 Get 1 Free", badgeLabel "Buy 2 Get 1", savings 15.00}]`.
