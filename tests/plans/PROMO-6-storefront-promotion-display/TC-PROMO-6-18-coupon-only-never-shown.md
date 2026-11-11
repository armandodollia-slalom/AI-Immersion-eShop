---
id: TC-PROMO-6-18
title: A coupon-only promotion is never shown on the storefront
type: sad
sad-path: validation
layer: e2e
covers: ["AC: promotion with requiresCoupon = true is never shown on the storefront"]
priority: P1
---

# TC-PROMO-6-18: A coupon-only promotion is never shown on the storefront

## Why

- Promotions.API already leaves coupon-only promotions out of `/active`, so a plain run would pass even if the WebApp ignored the flag. Raising promotion 4's priority above all others makes any leak visible as the banner and as a `-10%` badge on every item.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty. Run `UPDATE "Promotions" SET "Priority" = 100 WHERE "Id" = 4` in promotionsdb, then restart the WebApp container.

## Steps

1. Open `/` and `/item/1` (anonymous).

## Expected result

- The banner text is `20% off all hiking gear` (promotion 1), not `10% off everything with a coupon code`.
- Item 1 has no badge and no `.item-promotion` row; `FALL10`, `WELCOME5` and `Coupon only` appear nowhere on either page.
