---
id: TC-PROMO-3-11
title: A BuyXGetY that saves more beats a PercentOff on the same line
type: happy
layer: functional
covers: ["Algorithm step 4 non-stackable across types", "Decisions: BuyXGetY is always non-stackable"]
priority: P1
---

# TC-PROMO-3-11: A BuyXGetY that saves more beats a PercentOff on the same line

## Why

- Cross-type conflict: BuyXGetY and PercentOff compete in the same non-stackable pool. Product 40 is also given type 3 so promotions 1 and 2 both match.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: product 40 with `catalogTypeId` 3 (so promotion 1, 20% on Type 3, matches) and brand 5, unit price 15.00, quantity 3. Promotion 1 saves 9.00, promotion 2 saves 15.00.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "items": [
      {
        "productId": 40,
        "catalogTypeId": 3,
        "catalogBrandId": 5,
        "unitPrice": 15.0,
        "quantity": 3
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- The line is `{productId 40, lineTotal 45.00, discount 15.00, appliedPromotionIds [2]}`.
- `appliedPromotions` is exactly `[{id 2, name "Buy 2 Get 1 Free", badgeLabel "Buy 2 Get 1", savings 15.00}]`; promotion 1 is not listed.
