---
id: TC-PROMO-3-26
title: A coupon code is accepted and, until PROMO-4, reported as NotProvided without applying coupon-only promotions
type: happy
layer: functional
covers: ["Inputs: couponCode optional", "Outputs: coupon.status NotProvided", "Algorithm step 1 coupon-only promotions need an Applied coupon", "Decisions: NotProvidedCouponValidator stub"]
priority: P1
---

# TC-PROMO-3-26: A coupon code is accepted and, until PROMO-4, reported as NotProvided without applying coupon-only promotions

## Why

- The coupon validator is a stub until PROMO-4. This pins the stub contract (code ignored, status NotProvided, no reason) and that promotion 4 (coupon-only 10% on All) is not applied without an Applied coupon, even for a code that exists in the Coupons table.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Coupon FALL10 exists for promotion 4 (seed).

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "couponCode": "FALL10",
    "items": [
      {
        "productId": 99,
        "catalogTypeId": 9,
        "catalogBrandId": 9,
        "unitPrice": 100.0,
        "quantity": 1
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `coupon.status` is `NotProvided`, `coupon.reason` is not set (null), and `coupon.code` is null.
- `totalDiscount` 0.00 and `total` 100.00; `appliedPromotions` is empty (promotion 4 is not applied).
