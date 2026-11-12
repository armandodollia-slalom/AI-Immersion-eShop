---
story: BUG-10
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/32"
story-sha: 886f31490d23
plan-sha: 26f67f9542cb
verified-score: 9
verified-at: "2026-11-12T04:24:58.006Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: 859dc0b4d6fc
automation-plan-sha: 26f67f9542cb
automation-score: 10
automation-verified-at: "2026-11-12T04:31:56.385Z"
---
# Test plan: BUG-10 Invalid order status changes return 500 instead of a client error

Scope: the Ordering.API cancel and ship endpoints (`PUT /api/orders/cancel`, `PUT /api/orders/ship`). A broken order status rule (`OrderingDomainException`) must answer 409 Conflict with ProblemDetails whose `detail` is the rule message; unknown orders, other buyers' orders and non-admin ship keep 404, 404 and 403. All cases run at API level against the test stack with scenario `ordering-two-buyers` (alice, bob, admin), reloaded before each case because several cases change order status.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-10-01 | Cancelling a Shipped order returns 409 with the rule message | sad | functional | Expected 409 with message |
| TC-BUG-10-02 | Cancelling a Paid order returns 409 with the rule message | sad | functional | Technical Notes: SetCancelledStatus rule violation (Paid) |
| TC-BUG-10-03 | Shipping a Submitted order returns 409 with the rule message | sad | functional | Technical Notes: SetShippedStatus rule violation |
| TC-BUG-10-04 | Shipping a Cancelled order returns 409 with the rule message | sad | functional | Technical Notes: SetShippedStatus rule violation (Cancelled) |
| TC-BUG-10-05 | Shipping an already Shipped order returns 409 with the rule message | sad | functional | Technical Notes: SetShippedStatus rule violation (Shipped) |
| TC-BUG-10-06 | A rejected status change leaves the order unchanged | sad | functional | Implementation Notes: rethrown domain error rolls back the outer transaction |
| TC-BUG-10-07 | Retrying a rejected change with the same x-requestid returns 409 again | sad | functional | Implementation Notes: request id is not recorded, retry gets the same 409 |
| TC-BUG-10-08 | Cancelling an unknown order returns 404 | sad | functional | Suggested fix: return 404 when the order does not exist |
| TC-BUG-10-09 | Shipping an unknown order returns 404 | sad | functional | Suggested fix: return 404 when the order does not exist |
| TC-BUG-10-10 | Cancelling another buyer's order returns 404, not 409 | sad | functional | Implementation Notes: other buyers' orders keep 404 |
| TC-BUG-10-11 | Shipping as a non-Admin still returns 403 | sad | functional | Implementation Notes: ship by non-Admin keeps 403 from OrderingAdmin policy |
| TC-BUG-10-12 | Cancelling a Submitted order still returns 200 and cancels it | happy | functional | Regression: valid cancel unaffected |
| TC-BUG-10-13 | Shipping a Paid order as admin still returns 200 and ships it | happy | functional | Regression: valid ship unaffected |

## Out of scope

- Removing `test.fixme` in `e2e/teststack/ordering-api.spec.ts` and deleting the bug row in `testing/flows/`: repository changes checked by review, not runtime behavior.
- `POST /api/orders` status codes: owned by BUG-9.
- Missing, malformed or empty `x-requestid` (400) and missing token (401): unchanged and already covered by `ordering-api.spec.ts`.
- Duplicate `x-requestid` after a successful change: unchanged by this story.

## Open questions

- The story says "400 or 409" in Expected; the implementation notes choose 409, so the cases assert 409.
- Cancelling an already Cancelled order raises no domain exception in `SetCancelledStatus`; the story does not say what it should return, so no case covers it.
- Concurrent status changes on one order are not specified.
