---
id: TC-PROMO-3-08
title: Of two non-stackable matches only the one that saves more is applied
type: happy
layer: functional
covers: ["AC: two non-stackable promotions match -> larger saving", "Algorithm step 4 largest discount"]
priority: P1
---

# TC-PROMO-3-08: Of two non-stackable matches only the one that saves more is applied

## Why

- Protects that selection is by saving and not by priority: the bigger saving has the lower priority, so a priority-first implementation fails.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Extra promotion (id 8) created as setup before the steps with the admin token: `POST /api/promotions` with name `Hiking 30%`, type `PercentOff`, value 30, priority 1, targets `[{scope Type, targetId 3}]`, `startsAt` = now - 1 hour, `endsAt` = now + 30 days, `isStackable` false and `requiresCoupon` false unless stated, then `POST /api/promotions/8/publish`; it is Active (it is the only promotion with an id above 7).
- Cart: product 12 (type 3, brand 2), unit price 89.99, quantity 1. Promotion 1 (20%, priority 10) and promotion 8 (30%, priority 1) both match.

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
- The line is `{productId 12, lineTotal 89.99, discount 27.00, appliedPromotionIds [8]}` (89.99 x 0.30 = 26.997).
- `appliedPromotions` is exactly `[{id 8, name "Hiking 30%", badgeLabel "-30%", savings 27.00}]`; promotion 1 is not listed.
- `totalDiscount` 27.00 and `total` 62.99.
