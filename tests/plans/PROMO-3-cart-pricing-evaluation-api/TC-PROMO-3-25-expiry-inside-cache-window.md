---
id: TC-PROMO-3-25
title: A promotion whose EndsAt passes inside the 30 second cache window stops applying
type: sad
sad-path: boundary
layer: functional
covers: ["AC: expired promotion is never applied", "Decisions: cache re-filters by StartsAt/EndsAt on each read"]
priority: P1
---

# TC-PROMO-3-25: A promotion whose EndsAt passes inside the 30 second cache window stops applying

## Why

- Time-based expiry has no admin call that invalidates the cache, so only the re-filter on read keeps it correct. Needs real time to pass, so it is functional.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Extra promotion (id 8) created as setup before the steps with the admin token: `POST /api/promotions` with name `Ten percent 10 seconds`, type `PercentOff`, value 10, priority 1, targets `[{scope Type, targetId 6}]`, `endsAt` = now + 10 seconds (instead of now + 30 days), `startsAt` = now - 1 hour, `endsAt` = now + 30 days, `isStackable` false and `requiresCoupon` false unless stated, then `POST /api/promotions/8/publish`; it is Active (it is the only promotion with an id above 7).
- Cart: product 61 (type 6, brand 1), unit price 100.00, quantity 1.

## Steps

1. `POST /api/promotions/evaluate` with the evaluate token and body: (sent within 5 seconds of publishing promotion 8)
   ```json
   {
    "items": [
      {
        "productId": 61,
        "catalogTypeId": 6,
        "catalogBrandId": 1,
        "unitPrice": 100.0,
        "quantity": 1
      }
    ]
   }
   ```
2. Wait until 12 seconds after promotion 8 was published (before the 30 second cache time is up), then repeat step 1.

## Expected result

- Step 1: status `200`, line `discount 10.00`, `appliedPromotionIds [8]`.
- Step 2: status `200`, `totalDiscount` 0.00, `total` 100.00, `appliedPromotionIds []`, `appliedPromotions` empty.
