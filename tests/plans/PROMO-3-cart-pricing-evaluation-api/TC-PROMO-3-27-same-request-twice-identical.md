---
id: TC-PROMO-3-27
title: Sending the same request twice gives identical responses and changes no data
type: happy
layer: functional
covers: ["AC: same request sent twice -> identical responses", "Outputs: no side effects"]
priority: P1
---

# TC-PROMO-3-27: Sending the same request twice gives identical responses and changes no data

## Why

- Evaluation must be read-only: coupons are not used up and nothing is written. Compares both bodies and the row counts of the promotion tables and the event log.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Note the row counts of `Promotions`, `PromotionTargets` and `Coupons` and of `IntegrationEventLog` in `promotionsdb`.
- Cart: product 12 (type 3, brand 2) 89.99 x 1; product 40 (type 1, brand 5) 15.00 x 3; coupon code `FALL10`.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body:
   ```json
   {
    "couponCode": "FALL10",
    "items": [
      {
        "productId": 12,
        "catalogTypeId": 3,
        "catalogBrandId": 2,
        "unitPrice": 89.99,
        "quantity": 1
      },
      {
        "productId": 40,
        "catalogTypeId": 1,
        "catalogBrandId": 5,
        "unitPrice": 15.0,
        "quantity": 3
      }
    ]
   }
   ```
2. Send exactly the same request again.

## Expected result

- Both responses have status `200` and byte-for-byte equal JSON bodies.
- The row counts of `Promotions`, `PromotionTargets`, `Coupons` and `IntegrationEventLog` are unchanged.
- Coupon FALL10 still exists in `Coupons` (same row, nothing marked used).
