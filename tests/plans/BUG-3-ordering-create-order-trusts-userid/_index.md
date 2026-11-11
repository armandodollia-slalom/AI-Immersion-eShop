---
story: BUG-3
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/45"
story-sha: 35976dd798d9
plan-sha: 973c061cc73f
verified-score: 9
verified-at: "2026-11-11T21:38:28.782Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: 48cc68d477f0
automation-plan-sha: 973c061cc73f
automation-score: 9
automation-verified-at: "2026-11-11T22:26:30.274Z"
---
# Test plan: BUG-3 Create order uses the userId from the request body instead of the token

Covers `POST /api/orders` on Ordering.API: the order is created for the signed-in buyer (the token's `sub`), and a `userId` in the body that names another buyer no longer redirects the order. The chosen behavior (per the story's Implementation Notes) is to ignore the body `userId`, not to reject with 400/403. All behavior cases are functional against the `ordering-two-buyers` scenario (alice owns orders 1-6, bob owns 7-8); the docs check is a static unit-level check.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-3-01 | Bob posts an order with alice's userId; the order is created for bob only | sad | functional | Expected: order for the token's sub; AC 1 and AC 2 (fixme test) |
| TC-BUG-3-02 | Alice posts an order with bob's userId; the order is created for alice only | sad | functional | Reverse direction; AC 2 (rest of spec) |
| TC-BUG-3-03 | Bob posts an order with his own userId; the order is created for bob | happy | functional | Matching ids keep working |
| TC-BUG-3-04 | Create order without a token is rejected and creates nothing | sad | functional | Authentication |
| TC-BUG-3-05 | Bug row removed from testing/flows/ordering.md | happy | unit | AC 3: docs row removed |

## Out of scope

- Running `ordering-api.spec.ts` from inside a test (nested Playwright run); AC 2 is covered by TC-BUG-3-01 and TC-BUG-3-02, and the fixme removal is confirmed by a reviewer on the PR.
- Create order returning `200` on failure (BUG-9) and order details ownership (BUG-1).

## Open questions

- The story allows either ignoring or rejecting (`400`/`403`) a mismatched `userId`; cases follow the recorded decision (ignore, `200`).
- Whether the order's buyer name comes from the token rather than the body `userName` is not observable through the public API (order lists carry no buyer name); no case written.
- Wrong-scope token, missing `x-requestid`, and invalid body behavior are not part of this story; no cases written.
- Concurrency and idempotent replay of the same `x-requestid` are not stated; no case written.
