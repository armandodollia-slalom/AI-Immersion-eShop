---
id: TC-PROMO-6-15
title: With no active promotions every page renders as today
type: sad
sad-path: boundary
layer: e2e
covers: ["Outputs: Anywhere - no change when there are no active promotions", "Outputs: banner hidden if none"]
priority: P1
---

# TC-PROMO-6-15: With no active promotions every page renders as today

## Why

- The `default` scenario leaves promotionsdb empty, so `/active` returns `[]`. This is the baseline for the storefront and proves badge, row and banner are all conditional.

## Preconditions

- Scenario `default` freshly loaded (promotionsdb empty); WebApp restarted so its cache is empty.

## Steps

1. Open `/` and `/item/3` (anonymous).

## Expected result

- No `[data-promo-banner]`, no `.promotion-badge`, no `<s>` and no `.item-promotion` on either page.
- Item 3 shows `$79.99` on both pages.
