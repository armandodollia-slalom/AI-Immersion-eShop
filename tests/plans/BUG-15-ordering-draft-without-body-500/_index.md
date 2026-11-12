---
story: BUG-15
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/37"
story-sha: 6593d7bce628
plan-sha: 422fe15a0a3b
verified-score: 9
verified-at: "2026-11-12T04:56:30.111Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: 84ae9561da4b
automation-plan-sha: 422fe15a0a3b
automation-score: 10
automation-verified-at: "2026-11-12T05:01:42.968Z"
---
# Test plan: BUG-15 Creating an order draft without a body returns 500

Scope: `POST /api/orders/draft?api-version=1.0` in Ordering.API. A request with no body, or with `items: null`, must answer `400` with a validation problem instead of `500`, and create no order. Valid and empty-item drafts keep answering `200`. All cases are functional (API level on the test stack) with scenario `ordering-two-buyers`; none of them changes data, so the scenario needs no reload between cases.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-15-01 | Draft without a body is rejected with 400 and creates no order | sad | functional | Expected: 400 BadRequest; Code map: missing body |
| TC-BUG-15-02 | Draft with `items: null` is rejected with 400 on the Items key | sad | functional | Decisions: `items: null` rejected; Code map: Items key |
| TC-BUG-15-03 | Draft with `items: []` still returns 200 and an empty draft | happy | functional | Decisions: empty items stay valid |
| TC-BUG-15-04 | Draft with items still returns 200 and the computed total | happy | functional | Code map: valid items return 200 OrderDraftDTO |

## Out of scope

- Removing `test.fixme` and the bugs-table row in `testing/flows/`: repository changes checked by review; the existing e2e test "a draft request without a body is rejected with 400" is the automated form of TC-BUG-15-01.
- Missing or invalid token (401): unchanged by this story, covered by `ordering-api.spec.ts` "anonymous and invalid-token requests are rejected with 401".
- Absence of logging or mediator call on a 400: not observable through the API.

## Open questions

- Malformed JSON, or a body whose `items` has the wrong type: the story does not say what the response is. No case written.
- Empty body sent with an explicit `Content-Type: application/json` header versus no header: the story only says "no body". TC-BUG-15-01 uses no body and no content type.
- Exact `title` and message text of the validation problem are not given in the story beyond the keys (`""` and `Items`); cases assert status, `errors` key and a non-empty message only.
