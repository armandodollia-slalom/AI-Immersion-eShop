---
id: TC-PROMO-6-09
title: Shop the sale opens the catalog filtered to the promotion's type
type: happy
layer: e2e
covers: ["Outputs: Shop the sale link to the filtered catalog", "Rule: link to the filtered catalog"]
priority: P1
---

# TC-PROMO-6-09: Shop the sale opens the catalog filtered to the promotion's type

## Why

- The link target is derived from the promotion's target scope (`Type` 3 gives `/?type=3`); the story names a filtered catalog, so the click must land on a catalog that shows only that type.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.

## Steps

1. Open `/item/1` (anonymous).
2. Click the banner link `Shop the sale`.

## Expected result

- The link's `href` is `/?type=3` and the browser URL becomes `/?type=3`.
- The product grid shows only type-3 items (for example items 3, 5 and 12) and not item 1 or item 24.
