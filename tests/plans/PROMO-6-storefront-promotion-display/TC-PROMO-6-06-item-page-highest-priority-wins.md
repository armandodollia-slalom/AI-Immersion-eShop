---
id: TC-PROMO-6-06
title: Item page shows the highest-priority matching promotion
type: happy
layer: e2e
covers: ["Outputs: Item page - the highest-priority matching promotion"]
priority: P1
---

# TC-PROMO-6-06: Item page shows the highest-priority matching promotion

## Why

- Item 3 matches promotion 1 (type 3, priority 10); a second, higher-priority promotion on product 3 must take over. This is the priority-selection rule at the item page and needs real `/active` data and the started event, so e2e.

## Preconditions

- Scenario `promo-1` freshly loaded (promotions 1-7; active and shown-eligible: 1 Fall Hiking Sale 20% off type 3 priority 10, 2 Buy 2 Get 1 Free on product 40 priority 6, 3 `AmountOffOrder` $10 off over $150 on All priority 8; 4 is coupon-only; 5 Draft, 6 ended, 7 not started). Catalog from `default`: type 3 = items 3 ($79.99), 5 ($299.99), 12 ($399.00) and others; item 1 is type 1 brand 1 ($109.99); item 24 is type 4 brand 3 ($69.99); item 40 is $99.99. The WebApp slot was started after the scenario loaded, or restarted, so its 60s `/active` cache is empty.
- An admin access token for alice (client `webapp`, scopes including `promotions`, role `admin`), obtained as in `e2e/teststack/promo-1-promotions.spec.ts`.

## Steps

1. `POST /api/promotions?api-version=1.0` on Promotions.API with the admin token: `{"name":"Flash Snowboard Deal","description":"Half price on goggles","type":"PercentOff","value":50,"startsAt":<now minus 1 hour>,"endsAt":<now plus 30 days>,"priority":20,"targets":[{"scope":"Product","targetId":3}]}`; note the returned id.
2. `POST /api/promotions/{id}/publish?api-version=1.0` with the same token.
3. Poll `/item/3` every second for up to 30s until `.item-promotion` text contains `Flash Snowboard Deal`.

## Expected result

- Within 30s `.item-promotion` text starts with `Flash Snowboard Deal:` (not `Fall Hiking Sale:`).
- `/item/5` (type 3, not product 3) still shows `Fall Hiking Sale:`.
