---
id: TC-PROMO-6-16
title: Pages render at normal prices with a warning logged when Promotions.API is down
type: sad
sad-path: dependency-failure
layer: e2e
covers: ["AC: when Promotions.API can't be reached pages render at normal prices with no badges or banner and a warning is logged", "Outputs: Anywhere - no change when Promotions.API is down"]
priority: P1
---

# TC-PROMO-6-16: Pages render at normal prices with a warning logged when Promotions.API is down

## Why

- The storefront must never fail because an optional service is down. A real container stop is the only way to see the WebApp's HttpClient fail the way it does in production.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty. Then stop the Promotions.API container (`docker stop <project>-promotions-1`) and restart the WebApp container so no earlier `/active` result is cached.

## Steps

1. Open `/` and `/item/3` (anonymous).
2. Read the WebApp container logs (`docker logs <project>-webapp-1`).

## Expected result

- Both pages return HTTP 200 and render the product grid / item details.
- No `[data-promo-banner]`, no `.promotion-badge`, no `<s>` and no `.item-promotion`; item 3 shows `$79.99`.
- The WebApp log contains a warning-level entry `Could not load active promotions; showing regular prices`.
