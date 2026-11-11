---
id: TC-PROMO-3-17
title: nextThreshold.amountRemaining is measured after line discounts
type: happy
layer: functional
covers: ["AC: subtotal below threshold -> amountRemaining = 150 - subtotal after line discounts", "Decisions: thresholds measured after line discounts"]
priority: P1
---

# TC-PROMO-3-17: nextThreshold.amountRemaining is measured after line discounts

## Why

- The raw subtotal (159.99) is over 150 but the subtotal after line discounts (141.99) is not: a raw-subtotal implementation would wrongly apply the $10 and report no threshold.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: product 12 (type 3, brand 2) 89.99 x 1 (promotion 1 gives 18.00); product 99 (type 9, brand 9) 70.00 x 1.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "items": [
      {
        "productId": 12,
        "catalogTypeId": 3,
        "catalogBrandId": 2,
        "unitPrice": 89.99,
        "quantity": 1
      },
      {
        "productId": 99,
        "catalogTypeId": 9,
        "catalogBrandId": 9,
        "unitPrice": 70.0,
        "quantity": 1
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `subtotal` 159.99, `totalDiscount` 18.00, `total` 141.99.
- Promotion 3 is not applied: no `appliedPromotionIds` contains 3 and `appliedPromotions` has only promotion 1.
- `nextThreshold` is `{promotionId 3, minOrderTotal 150.00, amountRemaining 8.01, reward 10.00}`.
