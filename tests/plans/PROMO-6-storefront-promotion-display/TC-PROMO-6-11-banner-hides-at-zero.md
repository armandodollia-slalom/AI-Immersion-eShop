---
id: TC-PROMO-6-11
title: Banner hides itself when the countdown reaches zero, without a reload
type: happy
layer: e2e
covers: ["AC: when the countdown reaches zero the banner hides itself without a page reload"]
priority: P1
---

# TC-PROMO-6-11: Banner hides itself when the countdown reaches zero, without a reload

## Why

- Separate from the tick case because it is a different transition (visible to hidden). The fake clock jumps past `endsAt` so the case does not wait 90 days.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.

## Steps

1. Install the Playwright fake clock and open `/` (anonymous); confirm `[data-promo-banner]` is visible and set a marker on `window`.
2. Jump the clock to 91 days ahead with `page.clock.fastForward` and then `page.clock.runFor(1000)`.

## Expected result

- `[data-promo-banner]` is not visible (hidden attribute set) within that second.
- The marker from step 1 is still set (no reload) and the catalog grid is still rendered.
