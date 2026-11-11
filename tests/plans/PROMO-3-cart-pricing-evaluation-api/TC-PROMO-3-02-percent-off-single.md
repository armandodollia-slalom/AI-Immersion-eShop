---
id: TC-PROMO-3-02
title: One line matching a single PercentOff gets round(lineTotal x 0.20, 2)
type: happy
layer: functional
covers: ["AC: one line matches a single PercentOff", "Algorithm step 3 PercentOff", "Algorithm step 2 Type match", "Deviations: 18.00 not 17.99"]
priority: P1
---

# TC-PROMO-3-02: One line matching a single PercentOff gets round(lineTotal x 0.20, 2)

## Why

- Protects the PercentOff formula and the Type match. The story's output example shows 17.99 but the acceptance criterion's formula gives 18.00, so this case pins the formula result 18.00 (89.99 x 0.20 = 17.998).

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: product 12 (type 3, brand 2), unit price 89.99, quantity 1. Promotion 1 (20% on Type 3) matches.

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
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `subtotal` 89.99, `totalDiscount` 18.00, `total` 71.99.
- The line is `{productId 12, lineTotal 89.99, discount 18.00, appliedPromotionIds [1]}`.
- `appliedPromotions` is exactly `[{id 1, name "Fall Hiking Sale", badgeLabel "-20%", savings 18.00}]`.
- `coupon.status` is `NotProvided`.
- `nextThreshold` is `{promotionId 3, minOrderTotal 150.00, amountRemaining 78.01, reward 10.00}`.
