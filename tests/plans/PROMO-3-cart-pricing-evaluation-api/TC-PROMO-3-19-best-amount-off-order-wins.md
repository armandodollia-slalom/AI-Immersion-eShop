---
id: TC-PROMO-3-19
title: When two AmountOffOrder promotions are met only the best one is applied
type: happy
layer: functional
covers: ["Algorithm step 5 apply the best AmountOffOrder", "Algorithm step 7 rounding ToEven (midpoint shares)"]
priority: P1
---

# TC-PROMO-3-19: When two AmountOffOrder promotions are met only the best one is applied

## Why

- Protects that order-level discounts do not add up when non-stackable. The shares 9.375 and 5.625 are exact midpoints, so the case also pins MidpointRounding.ToEven on the split (9.38 and 5.62; away-from-zero would give 9.38 and 5.63 and total 15.01).

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Extra promotion (id 8) created as setup before the steps with the admin token: `POST /api/promotions` with name `Fifteen off over 100`, type `AmountOffOrder`, value 15, minOrderTotal 100, targets `[{scope All}]`, `startsAt` = now - 1 hour, `endsAt` = now + 30 days, `isStackable` false and `requiresCoupon` false unless stated, then `POST /api/promotions/8/publish`; it is Active (it is the only promotion with an id above 7).
- Cart: product 99 (type 9, brand 9) 100.00 x 1; product 98 (type 8, brand 8) 60.00 x 1 (subtotal 160.00). Promotions 3 ($10) and 8 ($15) are both met.

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
      },
      {
        "productId": 98,
        "catalogTypeId": 8,
        "catalogBrandId": 8,
        "unitPrice": 60.0,
        "quantity": 1
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `totalDiscount` 15.00 and `total` 145.00; line discounts are 9.38 (product 99) and 5.62 (product 98).
- Both lines have `appliedPromotionIds [8]`; `appliedPromotions` is exactly one entry with `id 8` and `savings 15.00`; promotion 3 is not listed.
- `nextThreshold` is null.
