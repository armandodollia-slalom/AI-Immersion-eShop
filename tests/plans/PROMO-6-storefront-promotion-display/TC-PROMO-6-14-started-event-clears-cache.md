---
id: TC-PROMO-6-14
title: PromotionStartedIntegrationEvent makes a newly published promotion visible
type: happy
layer: e2e
covers: ["Inputs: PromotionStartedIntegrationEvent clears the cache"]
priority: P2
---

# TC-PROMO-6-14: PromotionStartedIntegrationEvent makes a newly published promotion visible

## Why

- The started handler is the other cache clear. Promotion 5 is a Draft whose window is already open, so publishing it fires the started event; its `-5%` badge must appear well before the 60s cache expiry.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.
- An admin access token for alice (client `webapp`, scopes including `promotions`, role `admin`), obtained as in `e2e/teststack/promo-1-promotions.spec.ts`.

## Steps

1. Open `/` and confirm item 1 has no badge (fills the cache).
2. `POST /api/promotions/5/publish?api-version=1.0` with the admin token; expect 2xx.
3. Poll `/` every second for up to 30s and read the badge of item 1.

## Expected result

- Within 30s item 1 shows badge `-5%`, the original `$109.99` crossed out and the sale price `$104.49`.
- Item 3 still shows `-20%` (priority 10 beats priority 3).
