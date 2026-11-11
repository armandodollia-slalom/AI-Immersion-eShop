---
id: TC-PROMO-6-07
title: Banner shows the highest-priority promotion's description, countdown and link
type: happy
layer: e2e
covers: ["Outputs: Site banner one line with description, countdown and Shop the sale link", "AC: banner shows its description and a countdown"]
priority: P1
---

# TC-PROMO-6-07: Banner shows the highest-priority promotion's description, countdown and link

## Why

- Core banner output. Promotion 1 (priority 10) beats promotion 3 (priority 8, All) and promotion 2 (priority 6, Product-only); the countdown format `Xd Yh Zm left` is part of the contract.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.

## Steps

1. Open `/` (anonymous) and wait for `[data-promo-banner]`.

## Expected result

- The banner is visible, directly under the header bar.
- Its text contains `20% off all hiking gear` and does not contain `$10 off your order`.
- `[data-promo-countdown]` text matches `^\d+d \d+h \d+m left$` with days equal to 89 (ends in 90 days minus the time since load).
- The banner has a link with text `Shop the sale`.
