---
id: TC-PROMO-3-01
title: Cart with no matching items and no coupon gets no discount
type: happy
layer: functional
covers: ["AC: no matching items and no coupon", "Outputs: 200 shape", "Outputs: coupon.status NotProvided"]
priority: P1
---

# TC-PROMO-3-01: Cart with no matching items and no coupon gets no discount

## Why

- Baseline for the whole contract: protects the 200 shape, the zero-discount path and the NotProvided coupon status. Functional because it needs the cache, DB-backed promotions and auth.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: one line of product 99 (type 9, brand 9), unit price 20.00, quantity 2. No promotion targets product 99, type 9 or brand 9, except the All-scope promotions (3, 4, 5, 6, 7), none of which applies (3 needs 150, 4 needs a coupon, 5-7 are not Active).

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
- `subtotal` 40.00, `totalDiscount` 0.00, `total` 40.00.
- `lines` has one entry: `productId` 99, `lineTotal` 40.00, `discount` 0.00, `appliedPromotionIds` empty.
- `appliedPromotions` is empty.
- `coupon.status` is `NotProvided` and `coupon.reason` is not set (null).
- `nextThreshold` is `{promotionId 3, minOrderTotal 150.00, amountRemaining 110.00, reward 10.00}`.
