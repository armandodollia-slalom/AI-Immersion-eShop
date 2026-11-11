---
id: TC-PROMO-6-13
title: PromotionEndedIntegrationEvent removes the badge and banner on every later page load
type: happy
layer: e2e
covers: ["AC: when the WebApp receives PromotionEndedIntegrationEvent the next page load (and every one after it) shows no badge or banner for that promotion", "Inputs: PromotionEndedIntegrationEvent clears the cache"]
priority: P1
---

# TC-PROMO-6-13: PromotionEndedIntegrationEvent removes the badge and banner on every later page load

## Why

- The 60s cache would keep the promotion on screen after it ends; only the event handler clears it earlier. The case warms the cache first so a pass cannot come from an empty cache, and polls for less than the 60s cache lifetime.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.
- An admin access token for alice (client `webapp`, scopes including `promotions`, role `admin`), obtained as in `e2e/teststack/promo-1-promotions.spec.ts`.

## Steps

1. Open `/` and `/item/3`; confirm the `-20%` badge on item 3 and the banner text `20% off all hiking gear` (this fills the cache).
2. `POST /api/promotions/1/end?api-version=1.0` on Promotions.API with the admin token; expect 2xx.
3. Poll `/` every second for up to 30s until item 3 has no `.promotion-badge`.
4. Reload `/` twice more and open `/item/3` once.

## Expected result

- Within 30s item 3 has no badge, no `<s>` and shows only `$79.99`.
- On all three later loads the banner text does not contain `20% off all hiking gear` and `/item/3` has no `.item-promotion` row.
- The banner now shows promotion 3's description (`$10 off your order when you spend $150 or more`) with link `/`, because it is the next-highest active All promotion.
