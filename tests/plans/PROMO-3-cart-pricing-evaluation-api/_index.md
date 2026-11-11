---
story: PROMO-3
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/54"
story-sha: d07dbb35e0e5
plan-sha: f9204045a647
verified-score: 9
verified-at: "2026-11-11T19:41:02.176Z"
verified-by: qe-plan@c3934e11/73ba1657
automation-sha: b1a5bd278eee
automation-plan-sha: f9204045a647
automation-score: 10
automation-verified-at: "2026-11-11T20:07:22.644Z"
---
# Test plan: PROMO-3 [BE - Promotions.API] - Cart pricing evaluation API

This plan covers `POST /api/promotions/evaluate`: candidate selection (Active only, coupon-only promotions), matching by All, Product, Brand and Type, PercentOff and BuyXGetY line discounts, conflict resolution and stacking, the line cap, the order-level `AmountOffOrder` split, `nextThreshold`, rounding, the 30 second promotion cache, the coupon stub, authentication, input validation and the absence of side effects. Everything runs at the functional layer against real Postgres with the `promo-2` scenario (promotions 1-7, users alice and bob from `default`); the story has no UI and the pricing rules are only reachable through the endpoint in the functional host. Cases that need promotions beyond the seed create them through the admin API (create, then publish, which also invalidates the cache) and state them in their preconditions; ids of such promotions start at 8. The story's example ids (promotion 3 as the sock deal, 4 as the threshold) differ from the seed, so the cases use the seed ids (2 for Buy 2 Get 1, 3 for the `$10 off` threshold).

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-PROMO-3-01 | Cart with no matching items and no coupon gets no discount | happy | functional | AC: no matching items and no coupon; Outputs: 200 shape; Outputs: coupon.status NotProvided |
| TC-PROMO-3-02 | One line matching a single PercentOff gets round(lineTotal x 0.20, 2) | happy | functional | AC: one line matches a single PercentOff; Algorithm step 3 PercentOff; Algorithm step 2 Type match |
| TC-PROMO-3-03 | Product 40 with quantity 3 gets 1 free unit | happy | functional | AC: product 40 quantity 3 -> 1 free; Algorithm step 3 BuyXGetY; Algorithm step 2 Product match |
| TC-PROMO-3-04 | Product 40 with quantity 5 still gets only 1 free unit | happy | functional | AC: quantity 5 -> still 1 free; Algorithm step 3 floor(quantity / (buy + get)) |
| TC-PROMO-3-05 | Product 40 with quantity 6 gets 2 free units | happy | functional | AC: quantity 6 -> 2 free; Algorithm step 3 floor(quantity / (buy + get)) * get |
| TC-PROMO-3-06 | Product 40 with quantity 2 gets no free unit and is not listed as applied | happy | functional | Algorithm step 3 BuyXGetY (below one group); Decisions: 0-saving match is not listed as applied |
| TC-PROMO-3-07 | A promotion matches a line when any of its Brand or Product targets match | happy | functional | Algorithm step 2 Product == productId; Algorithm step 2 Brand == catalogBrandId; Algorithm step 2 any target matches |
| TC-PROMO-3-08 | Of two non-stackable matches only the one that saves more is applied | happy | functional | AC: two non-stackable promotions match -> larger saving; Algorithm step 4 largest discount |
| TC-PROMO-3-09 | Two non-stackable matches that save the same amount: the higher Priority is applied | happy | functional | AC: same saving -> higher Priority; Algorithm step 4 tie-break Priority |
| TC-PROMO-3-10 | Equal saving and equal Priority: the lower Id is applied | happy | functional | Algorithm step 4 tie-break lower Id |
| TC-PROMO-3-11 | A BuyXGetY that saves more beats a PercentOff on the same line | happy | functional | Algorithm step 4 non-stackable across types; Decisions: BuyXGetY is always non-stackable |
| TC-PROMO-3-12 | A stackable percentage is applied to the amount left after the winning non-stackable discount | happy | functional | Algorithm step 4 stackable matches added on top; Algorithm step 4 percentages applied to the remaining amount |
| TC-PROMO-3-13 | A line's discount is capped at its total | happy | functional | Algorithm step 6 caps; AC: no line goes below 0 |
| TC-PROMO-3-14 | Order-level $10 is split across lines by remaining total and adds up to exactly 10.00 | happy | functional | AC: subtotal after line discounts >= 150 -> $10 split, parts sum 10.00; Algorithm step 5 proportional split; Outputs: nextThreshold null |
| TC-PROMO-3-15 | At exactly the 150.00 threshold the rounding remainder of the split goes to the largest line | happy | functional | Algorithm step 5 remainder to the largest line; AC: subtotal at least $150 (boundary: equal); AC: parts add up to exactly 10.00 |
| TC-PROMO-3-16 | A subtotal of 149.99 does not get the order-level discount | sad | functional | AC: subtotal below the threshold; Algorithm step 5 MinOrderTotal at most the subtotal (boundary: just below); Outputs: nextThreshold |
| TC-PROMO-3-17 | nextThreshold.amountRemaining is measured after line discounts | happy | functional | AC: subtotal below threshold -> amountRemaining = 150 - subtotal after line discounts; Decisions: thresholds measured after line discounts |
| TC-PROMO-3-18 | nextThreshold is the unmet AmountOffOrder with the smallest amount remaining | happy | functional | Outputs: nextThreshold is the closest unmet AmountOffOrder; Decisions: nextThreshold smallest amountRemaining |
| TC-PROMO-3-19 | When two AmountOffOrder promotions are met only the best one is applied | happy | functional | Algorithm step 5 apply the best AmountOffOrder; Algorithm step 7 rounding ToEven (midpoint shares) |
| TC-PROMO-3-20 | Line discounts are rounded to 2 decimals with banker's rounding | happy | functional | Algorithm step 7 MidpointRounding.ToEven; Algorithm step 7 totalDiscount = sum of line discounts |
| TC-PROMO-3-21 | A Draft promotion is never applied | sad | functional | AC: promotion is Draft -> never applied; Algorithm step 1 EffectiveStatus = Active |
| TC-PROMO-3-22 | A promotion that has ended is never applied | sad | functional | AC: promotion expired -> never applied; Algorithm step 1 EffectiveStatus = Active |
| TC-PROMO-3-23 | A promotion that has not started yet is never applied | sad | functional | Algorithm step 1 EffectiveStatus = Active (Scheduled excluded) |
| TC-PROMO-3-24 | A promotion ended by an admin stops applying at once, inside the 30 second cache window | sad | functional | AC: expired promotion is never applied; Decisions: admin publish/update/end invalidate the cache; New code: PromotionCache 30s |
| TC-PROMO-3-25 | A promotion whose EndsAt passes inside the 30 second cache window stops applying | sad | functional | AC: expired promotion is never applied; Decisions: cache re-filters by StartsAt/EndsAt on each read |
| TC-PROMO-3-26 | A coupon code is accepted and, until PROMO-4, reported as NotProvided without applying coupon-only promotions | happy | functional | Inputs: couponCode optional; Outputs: coupon.status NotProvided; Algorithm step 1 coupon-only promotions need an Applied coupon |
| TC-PROMO-3-27 | Sending the same request twice gives identical responses and changes no data | happy | functional | AC: same request sent twice -> identical responses; Outputs: no side effects |
| TC-PROMO-3-28 | Evaluate without a token returns 401 | sad | functional | Outputs: 401 without a token |
| TC-PROMO-3-29 | Any signed-in user, without the admin role, can evaluate a cart | happy | functional | Inputs: authenticated; buyerId from the token sub claim; Decisions: default authorization policy |
| TC-PROMO-3-30 | An empty items array is rejected | sad | functional | Inputs: items 1-100 lines (below the minimum); Outputs: 400 ValidationProblem |
| TC-PROMO-3-31 | A body without items is rejected | sad | functional | Inputs: items required; Outputs: 400 ValidationProblem |
| TC-PROMO-3-32 | 101 lines are rejected | sad | functional | Inputs: items 1-100 lines (just above the maximum); Outputs: 400 ValidationProblem |
| TC-PROMO-3-33 | Exactly 100 lines are accepted | happy | functional | Inputs: items 1-100 lines (inside the maximum) |
| TC-PROMO-3-34 | Two lines with the same productId are rejected | sad | functional | Inputs: items each with a distinct productId; Outputs: 400 ValidationProblem |
| TC-PROMO-3-35 | A negative unitPrice is rejected | sad | functional | Inputs: unitPrice >= 0 (just below); Outputs: 400 ValidationProblem |
| TC-PROMO-3-36 | A unitPrice of 0 is accepted | happy | functional | Inputs: unitPrice >= 0 (boundary: equal) |
| TC-PROMO-3-37 | A quantity of 0 is rejected | sad | functional | Inputs: quantity >= 1 (just below); Outputs: 400 ValidationProblem |

## Out of scope

- Coupon validation results `Applied` and `Invalid` with the reasons `NotFound`, `Expired`, `UsageLimitReached`, `PerUserLimitReached` and `MinOrderNotMet`, and case-insensitive coupon codes: defined and built in PROMO-4; PROMO-3 ships a stub that always returns `NotProvided` (see TC-PROMO-3-26).
- Multi-tenancy acceptance criteria (AdventureWorks vs Northwind promotions, the `Promotions` flag, per-tenant cache key): tenancy (TENANT-*) is not in the codebase, so there is nothing to test yet.
- Persisting discounts on orders and the server-side re-check (PROMO-5) and the WebApp cart (PROMO-8).
- Unit tests of `PricingEngine` in `tests/Promotions.UnitTests`; this plan is integration level only.

## Open questions

- Anonymous callers: the story requires authentication; only the no-token 401 and a signed-in non-admin 200 are specified. A token without a `sub` claim, a wrong scope and a malformed token are not specified, so there is no case for them.
- `buyerId` is taken from `sub` and not from the body, but the stub validator ignores it, so a body `buyerId` cannot be observed until PROMO-4.
- Missing or unsupported `api-version`: stated only in the implementation notes, not in the story.
- Whether `coupon.code` is null or absent in the `NotProvided` response is not specified; TC-PROMO-3-26 follows the implementation note (code `null`).
- Behavior of two stackable `AmountOffOrder` promotions, an `AmountOffOrder` targeting less than `All`, a stackable `BuyXGetY`, and concurrency or Postgres outages are not defined by the story and have no case.
- The story's output example shows `17.99` for 20% of 89.99 while the acceptance criterion gives `18.00`; the plan follows the criterion (TC-PROMO-3-02).
