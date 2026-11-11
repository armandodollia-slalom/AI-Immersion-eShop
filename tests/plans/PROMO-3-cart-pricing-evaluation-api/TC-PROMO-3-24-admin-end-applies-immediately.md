---
id: TC-PROMO-3-24
title: A promotion ended by an admin stops applying at once, inside the 30 second cache window
type: sad
sad-path: conflict
layer: functional
covers: ["AC: expired promotion is never applied", "Decisions: admin publish/update/end invalidate the cache", "New code: PromotionCache 30s"]
priority: P1
---

# TC-PROMO-3-24: A promotion ended by an admin stops applying at once, inside the 30 second cache window

## Why

- The cache lasts 30 seconds; without invalidation a shopper would keep a discount for up to 30 seconds after an admin ended it. Needs two requests in sequence and the admin API, so it is functional.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: product 12 (type 3, brand 2), unit price 89.99, quantity 1.

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
2. `POST /api/promotions/1/end` with the admin token.
3. Immediately repeat step 1 (well under 30 seconds after step 1).

## Expected result

- Step 1: status `200`, line discount 18.00, `appliedPromotionIds [1]` (this fills the cache).
- Step 2: status `204`.
- Step 3: status `200`, `totalDiscount` 0.00, `total` 89.99, the line has `discount 0.00` and `appliedPromotionIds []`, and `appliedPromotions` is empty.
