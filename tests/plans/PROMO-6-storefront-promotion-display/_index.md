---
story: PROMO-6
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/57"
story-sha: a985d4dd0cb2
plan-sha: 33122faf08b9
verified-score: 9
verified-at: "2026-11-11T19:53:38.988Z"
verified-by: qe-plan@c3934e11/73ba1657
automation-sha: 993287ca913b
automation-plan-sha: 33122faf08b9
automation-score: 9
automation-verified-at: "2026-11-11T20:39:53.382Z"
---
# Test plan: PROMO-6 [FE - WebApp, WebAppComponents] - Storefront promotion display

This plan covers what the shopper sees from the active promotions feed: the catalog badge with crossed-out and sale price, the item-page promotion row, the site banner with its countdown and "Shop the sale" link, cache clearing on `PromotionStartedIntegrationEvent` and `PromotionEndedIntegrationEvent`, the fallback when Promotions.API is down or hanging, and the rule that coupon-only promotions are never shown. The story has no Test scope section, so each requirement sits at the cheapest layer that proves it: UI behavior runs as e2e on the test stack with the `promo-1` scenario (one case uses `default` for "no promotions"); pure logic in `PromotionPricing`, `PromotionMatching` and `PromotionsService` runs as unit cases. Every e2e case starts from a freshly loaded scenario with the WebApp restarted so its 60s `/active` cache is empty. Cases that change promotions use the PROMO-2 admin API with an admin token.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-PROMO-6-01 | Type-3 catalog items show -20%, the crossed-out price and the sale price | happy | e2e | Outputs: Catalog grid badge + crossed-out price + sale price for PercentOff; AC: every type-3 item shows -20%, original price crossed out and discounted price |
| TC-PROMO-6-02 | Items outside the promotion's type look the same as without promotions | sad | e2e | AC: items not in type 3 look the same as today; Outputs: only items that match get a badge; Outputs: AmountOffOrder never gets a badge |
| TC-PROMO-6-03 | BuyXGetY item shows its badge but no crossed-out or sale price | happy | e2e | Outputs: badge such as Buy 2 Get 1 for BuyXGetY; Rule: sale price shown for PercentOff only |
| TC-PROMO-6-04 | Type-3 item page shows the promotion name and end date next to the price | happy | e2e | Outputs: Item page promotion row with name and end date; AC: promotion name and end date show beside the price |
| TC-PROMO-6-05 | Item page of a non-matching item has no promotion row | sad | e2e | Outputs: item page row only for the highest-priority matching promotion; Outputs: AmountOffOrder never gets an item-page row |
| TC-PROMO-6-06 | Item page shows the highest-priority matching promotion | happy | e2e | Outputs: Item page - the highest-priority matching promotion |
| TC-PROMO-6-07 | Banner shows the highest-priority promotion's description, countdown and link | happy | e2e | Outputs: Site banner one line with description, countdown and Shop the sale link; AC: banner shows its description and a countdown |
| TC-PROMO-6-08 | Banner is also shown on an item page | happy | e2e | Outputs: Anywhere / AC: any page loads while the promotion has the highest priority |
| TC-PROMO-6-09 | Shop the sale opens the catalog filtered to the promotion's type | happy | e2e | Outputs: Shop the sale link to the filtered catalog; Rule: link to the filtered catalog |
| TC-PROMO-6-10 | Banner countdown updates in the browser without a reload | happy | e2e | AC: countdown that updates every second in the browser |
| TC-PROMO-6-11 | Banner hides itself when the countdown reaches zero, without a reload | happy | e2e | AC: when the countdown reaches zero the banner hides itself without a page reload |
| TC-PROMO-6-12 | Banner skips a higher-priority promotion that targets only a Product | sad | e2e | Outputs: banner - highest priority promotion that targets All, Type or Brand |
| TC-PROMO-6-13 | PromotionEndedIntegrationEvent removes the badge and banner on every later page load | happy | e2e | AC: when the WebApp receives PromotionEndedIntegrationEvent the next page load (and every one after it) shows no badge or banner for that promotion; Inputs: PromotionEndedIntegrationEvent clears the cache |
| TC-PROMO-6-14 | PromotionStartedIntegrationEvent makes a newly published promotion visible | happy | e2e | Inputs: PromotionStartedIntegrationEvent clears the cache |
| TC-PROMO-6-15 | With no active promotions every page renders as today | sad | e2e | Outputs: Anywhere - no change when there are no active promotions; Outputs: banner hidden if none |
| TC-PROMO-6-16 | Pages render at normal prices with a warning logged when Promotions.API is down | sad | e2e | AC: when Promotions.API can't be reached pages render at normal prices with no badges or banner and a warning is logged; Outputs: Anywhere - no change when Promotions.API is down |
| TC-PROMO-6-17 | A hanging Promotions.API delays a page load by at most the 2s timeout | sad | e2e | AC: page load time isn't affected by more than the 2s HttpClient timeout |
| TC-PROMO-6-18 | A coupon-only promotion is never shown on the storefront | sad | e2e | AC: promotion with requiresCoupon = true is never shown on the storefront |
| TC-PROMO-6-19 | SalePrice returns round(price x (1 - value/100), 2) for percent offers | happy | unit | Display price rule: round(price x (1 - value/100), 2); Rule: must match PROMO-3 for a quantity-1 line |
| TC-PROMO-6-20 | SalePrice with value 100 returns 0.00 | sad | unit | Display price rule: round(price x (1 - value/100), 2) at the upper limit of PercentOff value (PROMO-2: 0 < v <= 100) |
| TC-PROMO-6-21 | A promotion matches an item only through the column its target scope names | sad | unit | Inputs: Each CatalogItem (Id, CatalogTypeId, CatalogBrandId) matched against targets; Output rule: matches the item |
| TC-PROMO-6-22 | BestMatch picks the highest priority and breaks ties by the lowest id | happy | unit | Output rule: highest-priority matching promotion; Decision: ties go to the lowest id, same order as /active |
| TC-PROMO-6-23 | BestMatch ignores a coupon-only promotion even when it has the highest priority | sad | unit | AC: promotion with requiresCoupon = true is never shown (BestMatch) |
| TC-PROMO-6-24 | PromotionsService drops coupon-only promotions from the /active response | sad | unit | AC: promotion with requiresCoupon = true is never shown (PromotionsService read) |

## Out of scope

- Cart-page and checkout discount lines: moved to PROMO-8.
- Calling `/evaluate` per tile and stacked or order-level promotions on the badge: the story accepts that they are not reflected.
- HybridApp use of `PromotionBadge`: only the parameter-based design is a decision, not a behavior to test.
- The 60s cache lifetime itself and the 10s failure cache: implementation details labelled as proposal or decision, not acceptance criteria; clearing by event is covered.
- Promotions.API behavior (`/active` contents, lifecycle, events): covered by the PROMO-1 and PROMO-2 plans.
- Arithmetic parity with PROMO-3 `/evaluate`: PROMO-3 owns that calculation; here the display rule is checked against fixed expected values.

## Open questions

- The display rule does not state the rounding mode for exact midpoints (the code rounds to even). No case asserts a midpoint value; PROMO-3 must be checked for the same mode.
- The item-page example reads "Fall Hiking Sale: 20% off, ends Sun Nov 16", while the implementation prints the API badge label (`-20%`). TC-PROMO-6-04 only asserts the name prefix and the end date.
- "Updates every second" is not observable in the minutes-only countdown text; TC-PROMO-6-10 proves ticking through a minute rollover.
- Whether the banner may show an `AmountOffOrder` promotion is not stated; TC-PROMO-6-13 follows the literal rule (any type that targets All, Type or Brand).
- Behavior when the cached failure expires or Promotions.API recovers, and exact timing of event delivery to the WebApp, are undefined; cases poll for at most 30s.
- Whether a Brand-scoped promotion's banner link is `/?brand={id}` is a decision in the implementation notes, not an acceptance criterion; no case seeds a Brand-target promotion.
