---
id: TC-PROMO-6-03
title: BuyXGetY item shows its badge but no crossed-out or sale price
type: happy
layer: e2e
covers: ["Outputs: badge such as Buy 2 Get 1 for BuyXGetY", "Rule: sale price shown for PercentOff only"]
priority: P1
---

# TC-PROMO-6-03: BuyXGetY item shows its badge but no crossed-out or sale price

## Why

- The rule 'the sale price is shown for `PercentOff` only' is easy to break by applying the percent formula to every promotion; promotion 2 is the seeded `BuyXGetY` (value 0) and targets product 40.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.

## Steps

1. Open the catalog page `/` (anonymous).
2. Read the tile of item 40 (EcoTrek Trail Running Shoes, $99.99).

## Expected result

- The tile shows badge text `Buy 2 Get 1`.
- The tile has no `<s>` / `.price-original` and no `.price-sale` element; the price shown is `$99.99`.
