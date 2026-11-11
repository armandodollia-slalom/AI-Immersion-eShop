---
id: TC-PROMO-3-13
title: A line's discount is capped at its total
type: happy
layer: functional
covers: ["Algorithm step 6 caps", "AC: no line goes below 0"]
priority: P1
---

# TC-PROMO-3-13: A line's discount is capped at its total

## Why

- Protects the Ordering `OrderItem` parity rule: a 10.00 order discount on a 5.00 cart must not give a negative line or total.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Extra promotion (id 8) created as setup before the steps with the admin token: `POST /api/promotions` with name `Ten off over 1`, type `AmountOffOrder`, value 10, minOrderTotal 1, targets `[{scope All}]`, `startsAt` = now - 1 hour, `endsAt` = now + 30 days, `isStackable` false and `requiresCoupon` false unless stated, then `POST /api/promotions/8/publish`; it is Active (it is the only promotion with an id above 7).
- Cart: product 99 (type 9, brand 9), unit price 5.00, quantity 1. The subtotal 5.00 meets promotion 8's minimum 1.00 and its value 10.00 is above the line total.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "items": [
      {
        "productId": 99,
        "catalogTypeId": 9,
        "catalogBrandId": 9,
        "unitPrice": 5.0,
        "quantity": 1
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- The line is `{productId 99, lineTotal 5.00, discount 5.00, appliedPromotionIds [8]}`.
- `subtotal` 5.00, `totalDiscount` 5.00, `total` 0.00.
- `appliedPromotions` is exactly one entry with `id 8` and `savings 5.00`.
