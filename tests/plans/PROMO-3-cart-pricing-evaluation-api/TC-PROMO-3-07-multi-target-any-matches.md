---
id: TC-PROMO-3-07
title: A promotion matches a line when any of its Brand or Product targets match
type: happy
layer: functional
covers: ["Algorithm step 2 Product == productId", "Algorithm step 2 Brand == catalogBrandId", "Algorithm step 2 any target matches"]
priority: P1
---

# TC-PROMO-3-07: A promotion matches a line when any of its Brand or Product targets match

## Why

- Brand scope and a second target are not exercised by the seed (promotion 1 is Type, 2 is Product, 3 is All). One case with three lines shows match by product, match by brand and a non-match in one request.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Extra promotion (id 8) created as setup before the steps with the admin token: `POST /api/promotions` with name `Brand and Product 10%`, type `PercentOff`, value 10, priority 1, targets `[{scope Brand, targetId 5}, {scope Product, targetId 55}]`, `startsAt` = now - 1 hour, `endsAt` = now + 30 days, `isStackable` false and `requiresCoupon` false unless stated, then `POST /api/promotions/8/publish`; it is Active (it is the only promotion with an id above 7).
- Cart: product 55 (type 9, brand 1) 10.00 x 1; product 56 (type 9, brand 5) 10.00 x 1; product 57 (type 9, brand 2) 10.00 x 1.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "items": [
      {
        "productId": 55,
        "catalogTypeId": 9,
        "catalogBrandId": 1,
        "unitPrice": 10.0,
        "quantity": 1
      },
      {
        "productId": 56,
        "catalogTypeId": 9,
        "catalogBrandId": 5,
        "unitPrice": 10.0,
        "quantity": 1
      },
      {
        "productId": 57,
        "catalogTypeId": 9,
        "catalogBrandId": 2,
        "unitPrice": 10.0,
        "quantity": 1
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `subtotal` 30.00, `totalDiscount` 2.00, `total` 28.00.
- Lines in request order: product 55 `discount 1.00` with `appliedPromotionIds [8]` (Product target); product 56 `discount 1.00` with `appliedPromotionIds [8]` (Brand target); product 57 `discount 0.00` with `appliedPromotionIds []`.
- `appliedPromotions` is exactly `[{id 8, name "Brand and Product 10%", badgeLabel "-10%", savings 2.00}]`.
