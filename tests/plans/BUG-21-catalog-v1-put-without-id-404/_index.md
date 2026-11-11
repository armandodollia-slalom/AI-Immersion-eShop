---
story: BUG-21
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/44"
story-sha: 49961bd08a90
plan-sha: 1bdacf8faaed
verified-score: 9
verified-at: "2026-11-11T16:22:34.663Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: 7a56a1856142
automation-plan-sha: 1bdacf8faaed
automation-score: 9
automation-verified-at: "2026-11-11T16:34:02.631Z"
---
# Test plan: BUG-21 v1 PUT without an id returns 404 instead of 400

Scope: `PUT /api/catalog/items?api-version=1.0` on Catalog.API with the `catalog-edge` scenario (14 items, ids 1-14), called as an admin. A body with no `id` (bound to 0), an `id` of 0, or a negative `id` must return `400 BadRequest` "Item id must be provided in the request body." instead of `404` "Item with id 0 not found.", and must change nothing. Valid and unknown positive ids keep their behavior. All cases run at the functional layer (API against real Postgres) because the missing-id binding happens in the HTTP pipeline.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-21-01 | v1 PUT with no id in the body returns 400 with the id-required message | sad | functional | Expected: 400; Steps to Reproduce |
| TC-BUG-21-02 | v1 PUT with an explicit id of 0 returns 400 with the id-required message | sad | functional | Id <= 0 check, lower boundary |
| TC-BUG-21-03 | v1 PUT with a negative id returns 400 with the id-required message | sad | functional | Decisions: negative ids rejected |
| TC-BUG-21-04 | Rejected v1 PUT without an id leaves the catalog unchanged | sad | functional | Request rejected, nothing written |
| TC-BUG-21-05 | v1 PUT with a valid body id still updates the item | happy | functional | Fix must not break valid updates |
| TC-BUG-21-06 | v1 PUT with an unknown positive id still returns 404 | sad | functional | 404 kept for real but absent ids |

## Out of scope

- Removing the `test.fixme` marker in `e2e/teststack/catalog-admin.spec.ts` and the bugs-table row in `testing/flows/`: repository housekeeping, not runtime behavior. The spec test "v1 PUT without an id in the body is 400" automates TC-BUG-21-01.
- The v2 `PUT /items/{id}` endpoint (BUG-20), authentication on write endpoints (BUG-4), and field or reference validation (BUG-13, BUG-17, BUG-19).

## Open questions

- A null or empty request body is mentioned only in Implementation Notes ("null-body guard stays"); the story does not state the expected status, so no case covers it.
- Whether a missing id combined with an otherwise invalid body returns the id-required 400 or a validation problem is not stated; no case covers it.
- Concurrency and unauthenticated calls are not described for this bug; no cases.
