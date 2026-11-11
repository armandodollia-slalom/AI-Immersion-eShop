---
id: TC-PROMO-6-02
title: Items outside the promotion's type look the same as without promotions
type: sad
sad-path: boundary
layer: e2e
covers: ["AC: items not in type 3 look the same as today", "Outputs: only items that match get a badge", "Outputs: AmountOffOrder never gets a badge"]
priority: P1
---

# TC-PROMO-6-02: Items outside the promotion's type look the same as without promotions

## Why

- Protects against over-matching: item 24 has brand id 3 and item 1 has type 1, so a promotion with `Type` target 3 must not match them through the wrong id column. Promotion 3 (`AmountOffOrder`, All) and promotion 4 (coupon-only, All) also target everything, so a leak of either would badge these tiles.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.

## Steps

1. Open the catalog page `/` (anonymous).
2. Read the tiles of items 1 ($109.99) and 24 ($69.99) and of item 7 ($149.99, type 4).

## Expected result

- Items 1, 24 and 7 have no `.promotion-badge`, no `<s>` / `.price-original` and no `.price-sale` element.
- Their only price element shows `$109.99`, `$69.99` and `$149.99`.
