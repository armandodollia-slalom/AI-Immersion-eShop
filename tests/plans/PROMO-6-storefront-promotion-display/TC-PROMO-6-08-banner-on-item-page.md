---
id: TC-PROMO-6-08
title: Banner is also shown on an item page
type: happy
layer: e2e
covers: ["Outputs: Anywhere / AC: any page loads while the promotion has the highest priority"]
priority: P2
---

# TC-PROMO-6-08: Banner is also shown on an item page

## Why

- The banner sits in `MainLayout`, but an item page is a different route with its own data load; one extra page proves the banner is not catalog-only.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.

## Steps

1. Open `/item/1` (anonymous).

## Expected result

- `[data-promo-banner]` is visible with text containing `20% off all hiking gear` and a countdown matching `^\d+d \d+h \d+m left$`.
