---
id: TC-PROMO-6-10
title: Banner countdown updates in the browser without a reload
type: happy
layer: e2e
covers: ["AC: countdown that updates every second in the browser"]
priority: P1
---

# TC-PROMO-6-10: Banner countdown updates in the browser without a reload

## Why

- The banner is static server-rendered, so the update can only come from `promo-countdown.js`. The text only shows minutes, so the tick is proved by a minute rollover, which a fake clock makes fast and deterministic.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.

## Steps

1. Install the Playwright fake clock (`page.clock.install`) and open `/` (anonymous); read `[data-promo-countdown]` text (for example `89d 23h 59m left`) and record `performance.timeOrigin` / a marker set on `window` to detect reloads.
2. Advance the clock by exactly 60 seconds with `page.clock.runFor(60000)`.
3. Read `[data-promo-countdown]` text again.

## Expected result

- The second text differs from the first and equals it minus one minute (`89d 23h 58m left` when the first was `89d 23h 59m left`).
- No navigation happened: the `window` marker from step 1 is still set.
