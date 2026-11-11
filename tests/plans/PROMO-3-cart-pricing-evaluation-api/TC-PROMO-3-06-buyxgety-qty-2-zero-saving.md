---
id: TC-PROMO-3-06
title: Product 40 with quantity 2 gets no free unit and is not listed as applied
type: happy
layer: functional
covers: ["Algorithm step 3 BuyXGetY (below one group)", "Decisions: 0-saving match is not listed as applied"]
priority: P1
---

# TC-PROMO-3-06: Product 40 with quantity 2 gets no free unit and is not listed as applied

## Why

- Just below the first group (quantity 2 < buy 2 + get 1): protects the decision that a 0-saving match is not reported, so the cart does not show a badge for a deal that saves nothing.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: product 40 (type 1, brand 5), unit price 15.00, quantity 2.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "items": [
      {
        "productId": 40,
        "catalogTypeId": 1,
        "catalogBrandId": 5,
        "unitPrice": 15.0,
        "quantity": 2
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `subtotal` 30.00, `totalDiscount` 0.00, `total` 30.00.
- The line is `{productId 40, lineTotal 30.00, discount 0.00, appliedPromotionIds []}`.
- `appliedPromotions` is empty: a match that saves 0 is not listed as applied.
