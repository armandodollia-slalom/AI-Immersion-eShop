---
id: TC-PROMO-3-16
title: A subtotal of 149.99 does not get the order-level discount
type: sad
sad-path: boundary
layer: functional
covers: ["AC: subtotal below the threshold", "Algorithm step 5 MinOrderTotal at most the subtotal (boundary: just below)", "Outputs: nextThreshold"]
priority: P1
---

# TC-PROMO-3-16: A subtotal of 149.99 does not get the order-level discount

## Why

- Just outside the inclusive threshold: protects against an off-by-one (< vs <=) in the threshold comparison.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: product 99 (type 9, brand 9), unit price 149.99, quantity 1.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "items": [
      {
        "productId": 99,
        "catalogTypeId": 9,
        "catalogBrandId": 9,
        "unitPrice": 149.99,
        "quantity": 1
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `subtotal` 149.99, `totalDiscount` 0.00, `total` 149.99; the line has `discount 0.00` and `appliedPromotionIds []`; `appliedPromotions` is empty.
- `nextThreshold` is `{promotionId 3, minOrderTotal 150.00, amountRemaining 0.01, reward 10.00}`.
