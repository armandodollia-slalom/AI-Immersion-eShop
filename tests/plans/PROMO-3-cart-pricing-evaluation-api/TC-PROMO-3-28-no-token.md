---
id: TC-PROMO-3-28
title: Evaluate without a token returns 401
type: sad
sad-path: auth
layer: functional
covers: ["Outputs: 401 without a token"]
priority: P1
---

# TC-PROMO-3-28: Evaluate without a token returns 401

## Why

- Authentication is required (the cart page requires sign-in). Protects against the endpoint being exposed anonymously.

## Preconditions

- Promotions.API running in the functional test host against real Postgres with the `promo-2` scenario loaded (extends `default`; promotions 1-7: 1 Fall Hiking Sale PercentOff 20 on Type 3, priority 10, non-stackable; 2 Buy 2 Get 1 Free BuyXGetY 2+1 on Product 40, priority 6; 3 `$10 off orders over $150` AmountOffOrder value 10, minOrderTotal 150, target All, priority 8; 4 coupon-only PercentOff 10 on All with coupons FALL10 and WELCOME5; 5 Draft PercentOff 5 on All; 6 Published and ended yesterday, PercentOff 5 on All; 7 Published and starting tomorrow, PercentOff 5 on All). The database is reset before every case and the promotion cache is empty (Promotions.API restarted after the reset), so cases are order-independent. All requests pass `?api-version=1.0`.
- Evaluate token: user alice, scope `promotions` (any signed-in user is accepted; bob is used only where stated). Admin token (setup only): user alice, scope `promotions`, role `admin`.
- Cart: product 12 (type 3, brand 2), unit price 89.99, quantity 1.

## Steps

1. `POST /api/promotions/evaluate` with no `Authorization` header and body:
   ```json
   {
    "items": [
      {
        "productId": 12,
        "catalogTypeId": 3,
        "catalogBrandId": 2,
        "unitPrice": 89.99,
        "quantity": 1
      }
    ]
   }
   ```

## Expected result

- Status `401`.
- The response has no `subtotal` or `lines` fields (no pricing is returned).
