---
id: TC-PROMO-6-12
title: Banner skips a higher-priority promotion that targets only a Product
type: sad
sad-path: boundary
layer: e2e
covers: ["Outputs: banner - highest priority promotion that targets All, Type or Brand"]
priority: P1
---

# TC-PROMO-6-12: Banner skips a higher-priority promotion that targets only a Product

## Why

- The banner rule filters by target scope. A Product-only promotion with the highest priority must not take the banner, otherwise the 'Shop the sale' link has no category to open.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.
- An admin access token for alice (client `webapp`, scopes including `promotions`, role `admin`), obtained as in `e2e/teststack/promo-1-promotions.spec.ts`.

## Steps

1. Create and publish a promotion as in TC-PROMO-6-06 but named `Flash Snowboard Deal`, priority 20, target `Product` 3.
2. Poll `/item/3` until `.item-promotion` contains `Flash Snowboard Deal` (proves the WebApp saw the new promotion).
3. Open `/` and read the banner.

## Expected result

- The banner text contains `20% off all hiking gear` (Fall Hiking Sale) and not `Half price on goggles`.
- The banner link `href` is `/?type=3`.
