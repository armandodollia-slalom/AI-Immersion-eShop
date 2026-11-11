---
id: TC-PROMO-6-04
title: Type-3 item page shows the promotion name and end date next to the price
type: happy
layer: e2e
covers: ["Outputs: Item page promotion row with name and end date", "AC: promotion name and end date show beside the price"]
priority: P1
---

# TC-PROMO-6-04: Type-3 item page shows the promotion name and end date next to the price

## Why

- Covers the item-page output (`ItemPage.razor`), a different component and data path from the catalog badge, so it is its own case.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.

## Steps

1. Read `endsAt` of promotion 1 from `GET /api/promotions/active?api-version=1.0` on Promotions.API and format it as `ddd MMM d` (for example `Sun Nov 16`).
2. Open `/item/3` (anonymous).

## Expected result

- An element `.item-promotion` exists inside the price area of the add-to-cart form.
- Its text starts with `Fall Hiking Sale:` and contains the word "ends" followed by a space and the formatted end date from step 1.
- The item's price is still shown.
