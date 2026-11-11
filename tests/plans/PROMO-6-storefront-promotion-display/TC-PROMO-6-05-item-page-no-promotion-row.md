---
id: TC-PROMO-6-05
title: Item page of a non-matching item has no promotion row
type: sad
sad-path: boundary
layer: e2e
covers: ["Outputs: item page row only for the highest-priority matching promotion", "Outputs: AmountOffOrder never gets an item-page row"]
priority: P2
---

# TC-PROMO-6-05: Item page of a non-matching item has no promotion row

## Why

- Item 1 matches no `PercentOff` or `BuyXGetY` promotion, but promotions 3 (`AmountOffOrder`, All) and 4 (coupon-only, All) target All; showing either would be a regression.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.

## Steps

1. Open `/item/1` (anonymous).

## Expected result

- The page has no `.item-promotion` element.
- The text `$10 off` and `Coupon only` do not appear in the item's price area.
- The price `$109.99` is shown as before.
