---
story: BUG-1
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/31"
story-sha: 5ef8def79132
plan-sha: a410b95881c6
verified-score: 9
verified-at: "2026-11-11T11:31:56.317Z"
verified-by: qe-plan@c3934e11/456099fb
---
# Test plan: BUG-1 Any signed-in user can read any order by id

Covers `GET /api/orders/{id}` on Ordering.API: an order is returned only to its owning buyer, and a foreign order gives 404. All cases are functional, using the `ordering-two-buyers` scenario (alice owns orders 1-6, bob owns 7-8).

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-1-01 | Buyer reads own order details | happy | functional | Owner still gets own order |
| TC-BUG-1-02 | Second buyer reads own order details | happy | functional | Owner still gets own order |
| TC-BUG-1-03 | Alice cannot read bob's order; response is 404 with no order data | sad | functional | Expected 404, Actual 200 |
| TC-BUG-1-04 | Bob cannot read alice's order | sad | functional | Reverse direction |
| TC-BUG-1-07 | Ordering API spec passes with the fixme removed | happy | functional | AC 2: fixme removed, file passes |
| TC-BUG-1-08 | Bug row removed from testing/flows/ordering.md | happy | unit | AC 3: docs row removed |

## Out of scope

- Cancel and ship ownership (BUG-2) and create-order user id (BUG-3).

## Open questions

- Wrong-scope token behavior is not stated by the story; no case written.
- Status for a nonexistent order id and for a request without a token are not stated by the story; no case written.
- Concurrency and exact 404 body format are undefined.
