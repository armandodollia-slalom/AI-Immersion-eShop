---
story: BUG-7
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/49"
story-sha: 789ddc9db149
plan-sha: fa08c4a8594b
verified-score: 9
verified-at: "2026-11-11T10:47:04.835Z"
verified-by: qe-plan@09234f3a/456099fb
automation-sha: bf97d532be89
automation-plan-sha: fa08c4a8594b
automation-score: 10
automation-verified-at: "2026-11-11T10:59:01.487Z"
---
# Test plan: BUG-7 A basket line for a product no longer in the catalog breaks every page

Scope: with the `basket-edge` scenario, oscar's Redis basket holds a valid line (Explorer 45L Backpack, id 7) and a line for missing product `99999`. WebApp must skip the missing line, keep the site usable on every page and show the rest of the basket. All cases are e2e through the WebApp UI on the test stack.

| ID | Title | Type | Layer | Covers |
| ---- | ------- | ------ | ------- | -------- |
| TC-BUG-7-01 | Home page loads for oscar despite a missing-product basket line | happy | e2e | Expected: site works; cart menu renders on every page |
| TC-BUG-7-02 | Cart page shows the valid line and omits the missing product | happy | e2e | Expected: rest of the basket is shown, missing product dropped |
| TC-BUG-7-03 | Item detail page still loads when the basket references a missing product | sad (not-found) | e2e | Actual: every page fails; Expected: site works |

## Out of scope

- Actively deleting the stale line from Redis on read (decision: not done; not required by the story).
- Editing `e2e/teststack/basket-cart.spec.ts` and `testing/flows/` (acceptance items about repo files, not runtime behavior).
- Basket quantity validation (BUG-8).

## Open questions

- Expected cart badge count for oscar is not stated; cases do not assert it.
- Whether a missing line is "dropped" or "flagged" is left open by the story; cases only assert the page does not fail and shows the valid line.
