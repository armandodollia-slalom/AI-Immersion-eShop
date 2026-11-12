---
story: BUG-9
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/51"
story-sha: dff8992e4b70
plan-sha: 0c7e90861199
verified-score: 9
verified-at: "2026-11-12T04:42:19.516Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: df4107a7ebd3
automation-plan-sha: 0c7e90861199
automation-score: 10
automation-verified-at: "2026-11-12T04:48:24.184Z"
---
# Test plan: BUG-9 Create order returns 200 when the order was not created

Scope: `POST /api/orders` in Ordering.API. When the create-order command fails validation, the endpoint must answer `400` with a validation problem (errors grouped by property) and create no order. All cases are functional (API level on the test stack) with scenario `ordering-two-buyers`, reloaded before each case because some cases create orders.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-9-01 | Empty items list is rejected with 400 and the validator message | sad | functional | Expected 400 with validation errors |
| TC-BUG-9-02 | A rejected order creates no order | sad | functional | Expected: no order is created |
| TC-BUG-9-03 | Several validation failures are returned together, grouped by property | sad | functional | Implementation Notes: errors grouped by PropertyName |
| TC-BUG-9-04 | Expired card is rejected with 400 and the expiration message | sad | functional | Validator: CardExpiration |
| TC-BUG-9-05 | Card number of 11 characters is rejected with 400 | sad | functional | Validator: CardNumber lower boundary |
| TC-BUG-9-06 | Card number of 12 characters is accepted with 200 | happy | functional | Validator: CardNumber lower boundary |
| TC-BUG-9-07 | Card security number of 2 characters is rejected with 400 | sad | functional | Validator: CardSecurityNumber |
| TC-BUG-9-08 | Empty x-requestid still returns 400 "RequestId is missing." | sad | functional | Regression: RequestId check |
| TC-BUG-9-09 | A valid order is still created with 200 | happy | functional | Regression: success path |

## Out of scope

- Removing `test.fixme` in `e2e/teststack/ordering-api.spec.ts` and deleting the bug row in `testing/flows/`: repository changes checked by review.
- Missing token (401) and ownership of the buyer: unchanged, covered by `ordering-api.spec.ts` and BUG-3.
- Non-validation `OrderingDomainException` (answered as `{"": [message]}`) and a `false` mediator result (`{"": ["The order could not be created."]}`): not reachable through the API with the seeded data.

## Open questions

- Retrying a rejected create with the same `x-requestid`: the story does not say whether the retry gets the same 400. No case written.
- The exact `errors` key casing (`OrderItems`) follows the `CreateOrderCommand` property names as the Implementation Notes state (PropertyName).
