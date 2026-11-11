---
id: TC-PROMO-3-10
title: "Equal saving and equal Priority: the lower Id is applied"
type: happy
layer: functional
covers: ["Algorithm step 4 tie-break lower Id"]
priority: P1
---

# TC-PROMO-3-10: Equal saving and equal Priority: the lower Id is applied

## Why

- Second tie-break, the last rule of step 4: a stable, documented outcome so the same cart always prices the same.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Extra promotion (id 8) created as setup before the steps with the admin token: `POST /api/promotions` with name `Hiking 20% twin`, type `PercentOff`, value 20, priority 10, targets `[{scope Type, targetId 3}]`, `startsAt` = now - 1 hour, `endsAt` = now + 30 days, `isStackable` false and `requiresCoupon` false unless stated, then `POST /api/promotions/8/publish`; it is Active (it is the only promotion with an id above 7).
- Cart: product 12 (type 3, brand 2), unit price 89.99, quantity 1. Promotion 1 (20%, priority 10) and promotion 8 (20%, priority 10) both match.

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
- The line is `{productId 12, lineTotal 89.99, discount 18.00, appliedPromotionIds [1]}`.
- `appliedPromotions` is exactly one entry, `{id 1, name "Fall Hiking Sale", badgeLabel "-20%", savings 18.00}`; promotion 8 is not listed.
