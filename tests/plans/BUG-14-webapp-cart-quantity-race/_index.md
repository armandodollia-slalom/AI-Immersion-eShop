---
story: BUG-14
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/36"
story-sha: 047180f26a01
plan-sha: e2a9ffd609c6
verified-score: 9
verified-at: "2026-11-11T16:15:33.626Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: 006932dff150
automation-plan-sha: e2a9ffd609c6
automation-score: 9
automation-verified-at: "2026-11-11T16:42:02.028Z"
---
# Test plan: BUG-14 Typing a cart quantity, pressing Enter, then clicking Decrease can save the wrong quantity

Scope: the cart quantity box (`src/WebApp/wwwroot/js/cart-quantity.js`) on the WebApp cart page. After a quantity is committed with Enter, the blur `change` that follows (for example from clicking Decrease) must not submit the typed value again, so Redis and the UI agree. Typing a new value and blurring must still commit it. All cases run through the UI on the test stack with the `basket-edge` scenario (`e2e/teststack/basket-cart.spec.ts`, project `scenarios`).

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-14-01 | Enter then Decrease stores the decremented quantity | happy | e2e | Expected: stored quantity is 4 matching the UI; Acceptance criterion 1 |
| TC-BUG-14-02 | Enter then Decrease sends exactly one cart POST | sad | e2e | Technical Notes: change must not submit the typed value again in parallel |
| TC-BUG-14-03 | Typing a new value after Enter and blurring still commits it | sad | e2e | Implementation Notes: input event clears the committed mark |
| TC-BUG-14-04 | Typing a value and blurring without Enter commits it once | happy | e2e | Implementation Notes: typed value + blur still commits once |
| TC-BUG-14-05 | Basket cart spec passes with the fixme marker removed | happy | e2e | Acceptance criterion 2 |
| TC-BUG-14-06 | Bugs table in testing/flows has no row for this bug | happy | unit | Acceptance criterion 3 |

## Out of scope

- Server-side basket handling and the other cart pages: unchanged by this bug.

## Open questions

- Acceptance criteria say to repeat the steps as bob; the existing spec uses alice with a fresh basket. The cases use bob as the story states.
- The bug is intermittent, so TC-BUG-14-01 repeats the flow 5 times (as the existing spec does) and TC-BUG-14-02 provides the deterministic check.
