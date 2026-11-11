---
id: TC-PROMO-6-01
title: Type-3 catalog items show -20%, the crossed-out price and the sale price
type: happy
layer: e2e
covers: ["Outputs: Catalog grid badge + crossed-out price + sale price for PercentOff", "AC: every type-3 item shows -20%, original price crossed out and discounted price"]
priority: P1
---

# TC-PROMO-6-01: Type-3 catalog items show -20%, the crossed-out price and the sale price

## Why

- The headline requirement of the story. It runs at e2e because the badge, the crossed-out price and the sale price are only assembled when the WebApp renders the catalog with real `/active` data; the price values also pin the display rule against PROMO-3.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.

## Steps

1. Open the WebApp catalog page `/` (anonymous) and wait for the product grid.
2. For items 3, 5 and 12, read the tile's `.promotion-badge`, `.price-original` (`<s>`) and `.price-sale` texts.

## Expected result

- Item 3: badge `-20%`, original `$79.99` crossed out, sale `$63.99`.
- Item 5: badge `-20%`, original `$299.99` crossed out, sale `$239.99`.
- Item 12: badge `-20%`, original `$399.00` crossed out, sale `$319.20`.
- Every one of those tiles has exactly one badge and one `<s>` element.
