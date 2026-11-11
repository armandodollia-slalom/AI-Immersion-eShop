---
id: TC-PROMO-6-17
title: A hanging Promotions.API delays a page load by at most the 2s timeout
type: sad
sad-path: dependency-failure
layer: e2e
covers: ["AC: page load time isn't affected by more than the 2s HttpClient timeout"]
priority: P1
---

# TC-PROMO-6-17: A hanging Promotions.API delays a page load by at most the 2s timeout

## Why

- Down is not the same as slow: a paused container accepts connections but never answers, which is the case the 2s timeout exists for. The bound is measured against a baseline load of the same page.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty. Measure the load time of `/` once as a baseline with Promotions.API running, then pause the container (`docker pause <project>-promotions-1`) and restart the WebApp container so the cache is empty.

## Steps

1. Navigate to `/` (anonymous) and record the time until the product grid is rendered (`domcontentloaded` plus grid visible).

## Expected result

- The page renders with item 3 at `$79.99`, no badge and no banner.
- Elapsed time is at most the baseline plus 2s plus 1.5s of tolerance (a hang that waited for the default resilience timeout would take far longer).
