---
id: TC-PROMO-3-14
title: Order-level $10 is split across lines by remaining total and adds up to exactly 10.00
type: happy
layer: functional
covers: ["AC: subtotal after line discounts >= 150 -> $10 split, parts sum 10.00", "Algorithm step 5 proportional split", "Outputs: nextThreshold null"]
priority: P1
---

# TC-PROMO-3-14: Order-level $10 is split across lines by remaining total and adds up to exactly 10.00

## Why

- Core order-level behavior with a line discount in play: the threshold is measured after line discounts (161.99) and the split uses the remaining totals (71.99 and 90.00), not the original ones.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: product 12 (type 3, brand 2) 89.99 x 1 (promotion 1 gives 18.00, leaving 71.99); product 99 (type 9, brand 9) 90.00 x 1 (no line promotion).

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
      },
      {
        "productId": 99,
        "catalogTypeId": 9,
        "catalogBrandId": 9,
        "unitPrice": 90.0,
        "quantity": 1
      }
    ]
   }
   ```

## Expected result

- Status `200`.
- `subtotal` 179.99, `totalDiscount` 28.00, `total` 151.99.
- Line 12: `lineTotal 89.99`, `discount 22.44` (18.00 + 4.44), `appliedPromotionIds [1, 3]`. Line 99: `lineTotal 90.00`, `discount 5.56`, `appliedPromotionIds [3]`.
- The order-level parts 4.44 + 5.56 equal exactly 10.00.
- `appliedPromotions` is `[{id 1, ..., savings 18.00}, {id 3, name "$10 off orders over $150", badgeLabel "$10 off", savings 10.00}]`.
- `nextThreshold` is null.
