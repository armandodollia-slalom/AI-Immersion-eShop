---
id: TC-PROMO-3-12
title: A stackable percentage is applied to the amount left after the winning non-stackable discount
type: happy
layer: functional
covers: ["Algorithm step 4 stackable matches added on top", "Algorithm step 4 percentages applied to the remaining amount"]
priority: P1
---

# TC-PROMO-3-12: A stackable percentage is applied to the amount left after the winning non-stackable discount

## Why

- Protects the order of operations: 10% of the remaining 80.00 is 8.00, not 10% of 100.00 (10.00). Needs an extra stackable promotion because the seed has none.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Extra promotion (id 8) created as setup before the steps with the admin token: `POST /api/promotions` with name `Extra 10% stackable`, type `PercentOff`, value 10, priority 5, `isStackable` true, targets `[{scope Type, targetId 3}]`, `startsAt` = now - 1 hour, `endsAt` = now + 30 days, `isStackable` false and `requiresCoupon` false unless stated, then `POST /api/promotions/8/publish`; it is Active (it is the only promotion with an id above 7).
- Cart: product 13 (type 3, brand 7), unit price 100.00, quantity 1.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "items": [
      {
        "productId": 13,
        "catalogTypeId": 3,
        "catalogBrandId": 7,
        "unitPrice": 100.0,
        "quantity": 1
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- The line is `{productId 13, lineTotal 100.00, discount 28.00, appliedPromotionIds [1, 8]}` (20.00 from promotion 1, then 10% of 80.00 = 8.00).
- `appliedPromotions` is exactly `[{id 1, ..., savings 20.00}, {id 8, name "Extra 10% stackable", badgeLabel "-10%", savings 8.00}]`, ordered by id.
- `totalDiscount` 28.00 and `total` 72.00.
