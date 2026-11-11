---
id: TC-PROMO-3-34
title: Two lines with the same productId are rejected
type: sad
sad-path: validation
layer: functional
covers: ["Inputs: items each with a distinct productId", "Outputs: 400 ValidationProblem"]
priority: P1
---

# TC-PROMO-3-34: Two lines with the same productId are rejected

## Why

- A repeated product would double count a line and its free units.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: two lines for product 12.

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
        "productId": 12,
        "catalogTypeId": 3,
        "catalogBrandId": 2,
        "unitPrice": 89.99,
        "quantity": 2
      }
    ]
   }
   ```

## Expected result

- Status `400` with a ValidationProblem body (`title` `One or more validation errors occurred.`).
- `errors` contains key `items[1].productId`.
- No `subtotal`, `lines` or `appliedPromotions` is returned.
