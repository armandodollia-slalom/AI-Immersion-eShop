---
story: BUG-2
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/42"
story-sha: da5801dc45af
plan-sha: cfa7ce56c511
verified-score: 9
verified-at: "2026-11-11T21:58:18.179Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: b0bf6b06dd94
automation-plan-sha: cfa7ce56c511
automation-score: 9
automation-verified-at: "2026-11-11T22:16:59.671Z"
---
# Test plan: BUG-2 Any signed-in user can cancel or ship any order

Covers `PUT /api/orders/cancel` and `PUT /api/orders/ship` on Ordering.API: cancel is limited to the order's owner (others get `404`, same as unknown orders), ship requires role `Admin` (buyers get `403`; admin on an unknown order gets `404`). Behavior cases are functional against the `ordering-two-buyers` scenario (alice owns 1-6, bob owns 7-8) with users alice, bob and `admin`; the docs check is a static unit-level check.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-2-01 | Alice cannot cancel bob's order; 404, unchanged | sad | functional | Expected: 404/403, status unchanged |
| TC-BUG-2-02 | Bob cannot cancel alice's cancellable Submitted order | sad | functional | Cancel ownership check |
| TC-BUG-2-03 | Cancelling an unknown order returns the same 404 as not-owned | sad | functional | Decision: indistinguishable 404 |
| TC-BUG-2-04 | Owner can still cancel their own order | happy | functional | Own-order cancel returns 200 |
| TC-BUG-2-05 | Buyer alice cannot ship bob's Paid order; 403, unchanged | sad | functional | Steps to Reproduce; ship role gate |
| TC-BUG-2-06 | Buyer cannot ship even their own Paid order | sad | functional | Ship limited to back-office role |
| TC-BUG-2-07 | Admin can ship any Paid order | happy | functional | Policy OrderingAdmin allows Admin |
| TC-BUG-2-08 | Admin shipping an unknown order gets 404 | sad | functional | Decision: admin unknown order 404 |
| TC-BUG-2-09 | Buyer ship with empty x-requestid gets 403 | sad | functional | Decision: 403 before the endpoint |
| TC-BUG-2-10 | Admin ship with empty x-requestid gets 400 | sad | functional | Decision: admins still get 400 |
| TC-BUG-2-11 | Cancel and ship without a token return 401 | sad | functional | Authentication still required |
| TC-BUG-2-12 | ordering-api spec passes with fixme removed | happy | functional | AC 2 |
| TC-BUG-2-13 | Bug row removed from testing/flows/ordering.md | happy | unit | AC 3 |

## Out of scope

- Cancel with an empty `x-requestid` by the owner (`400`, unchanged behavior, already covered by the existing "cancel and ship require a valid, non-empty x-requestid" spec test).
- Order details ownership (BUG-1) and create-order identity (BUG-3).
- Unit tests of `OrdersWebApiTest` (owned by the implementation).

## Open questions

- Whether an `Admin` may cancel another buyer's order is not stated; the implementation uses the caller's own orders for cancel, so it would get `404`. No case written.
- Behavior of a token with the wrong scope (not `orders`) on cancel/ship is not stated; no case written.
- Concurrent cancel/ship and replay of the same `x-requestid` by a non-owner are not stated; no case written.
