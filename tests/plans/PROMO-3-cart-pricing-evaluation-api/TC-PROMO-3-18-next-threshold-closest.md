---
id: TC-PROMO-3-18
title: nextThreshold is the unmet AmountOffOrder with the smallest amount remaining
type: happy
layer: functional
covers: ["Outputs: nextThreshold is the closest unmet AmountOffOrder", "Decisions: nextThreshold smallest amountRemaining"]
priority: P1
---

# TC-PROMO-3-18: nextThreshold is the unmet AmountOffOrder with the smallest amount remaining

## Why

- The seed has a single AmountOffOrder, so closeness is not exercised without a second one. Protects the selection (closest, not first or biggest reward).

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Extra promotion (id 8) created as setup before the steps with the admin token: `POST /api/promotions` with name `Five off over 100`, type `AmountOffOrder`, value 5, minOrderTotal 100, targets `[{scope All}]`, `startsAt` = now - 1 hour, `endsAt` = now + 30 days, `isStackable` false and `requiresCoupon` false unless stated, then `POST /api/promotions/8/publish`; it is Active (it is the only promotion with an id above 7).
- Cart: product 99 (type 9, brand 9), unit price 20.00, quantity 2 (subtotal 40.00). Promotion 3 needs 110.00 more, promotion 8 needs 60.00 more.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "items": [
      {
        "productId": 99,
        "catalogTypeId": 9,
        "catalogBrandId": 9,
        "unitPrice": 20.0,
        "quantity": 2
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `totalDiscount` 0.00 and `total` 40.00.
- `nextThreshold` is `{promotionId 8, minOrderTotal 100.00, amountRemaining 60.00, reward 5.00}`.
