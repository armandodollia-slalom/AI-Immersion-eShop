---
id: TC-PROMO-3-15
title: At exactly the 150.00 threshold the rounding remainder of the split goes to the largest line
type: happy
layer: functional
covers: ["Algorithm step 5 remainder to the largest line", "AC: subtotal at least $150 (boundary: equal)", "AC: parts add up to exactly 10.00"]
priority: P1
---

# TC-PROMO-3-15: At exactly the 150.00 threshold the rounding remainder of the split goes to the largest line

## Why

- Two behaviors share one request because they share one cart: the subtotal equals the threshold exactly (inclusive boundary) and the proportional shares 4.67 + 2.67 + 2.67 = 10.01 overshoot, so 0.01 must come off the largest line.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: product 99 (type 9, brand 9) 70.00 x 1; product 98 (type 8, brand 8) 40.00 x 1; product 97 (type 7, brand 7) 40.00 x 1. No line promotion matches; subtotal is exactly 150.00.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "items": [
      {
        "productId": 99,
        "catalogTypeId": 9,
        "catalogBrandId": 9,
        "unitPrice": 70.0,
        "quantity": 1
      },
      {
        "productId": 98,
        "catalogTypeId": 8,
        "catalogBrandId": 8,
        "unitPrice": 40.0,
        "quantity": 1
      },
      {
        "productId": 97,
        "catalogTypeId": 7,
        "catalogBrandId": 7,
        "unitPrice": 40.0,
        "quantity": 1
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `subtotal` 150.00, `totalDiscount` 10.00, `total` 140.00.
- Line discounts in request order: product 99 `4.66`, product 98 `2.67`, product 97 `2.67`; they add up to exactly 10.00 and each `appliedPromotionIds` is `[3]`.
- `nextThreshold` is null.
