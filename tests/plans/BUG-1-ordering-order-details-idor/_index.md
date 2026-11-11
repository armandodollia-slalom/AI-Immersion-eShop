---
story: BUG-1
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/31"
story-sha: 3368a1204e22
plan-sha: 1b7ff1ad465e
verified-score: 9
verified-at: "2026-11-11T21:17:16.953Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: c6c40faff0d4
automation-plan-sha: 1b7ff1ad465e
automation-score: 9
automation-verified-at: "2026-11-11T21:21:35.929Z"
---
# Test plan: BUG-1 Any signed-in user can read any order by id

Covers `GET /api/orders/{id}` on Ordering.API: an order is returned only to its owning buyer, and a foreign order gives 404. All cases are functional, using the `ordering-two-buyers` scenario (alice owns orders 1-6, bob owns 7-8).

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-1-01 | Buyer reads own order details | happy | functional | Owner still gets own order |
| TC-BUG-1-02 | Second buyer reads own order details | happy | functional | Owner still gets own order |
| TC-BUG-1-03 | Alice cannot read bob's order; response is 404 with no order data | sad | functional | Expected 404, Actual 200; AC 2 (fixme test) |
| TC-BUG-1-04 | Bob cannot read alice's order | sad | functional | Reverse direction; AC 2 (rest of spec) |
| TC-BUG-1-08 | Bug row removed from testing/flows/ordering.md | happy | unit | AC 3: docs row removed |

## Out of scope

- Running `ordering-api.spec.ts` from inside a test (nested Playwright run). Per the human decision (Round 1, Q1 = C), AC 2 is covered by TC-BUG-1-03 and TC-BUG-1-04, and the fixme removal is confirmed by a reviewer on the PR.
- Cancel and ship ownership (BUG-2) and create-order user id (BUG-3).

## Open questions

- Wrong-scope token behavior is not stated by the story; no case written.
- Status for a nonexistent order id and for a request without a token are not stated by the story; no case written.
- Concurrency and exact 404 body format are undefined.
