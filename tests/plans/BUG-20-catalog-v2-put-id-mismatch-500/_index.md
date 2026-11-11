---
story: BUG-20
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/43"
story-sha: 8c4fcbab89c8
plan-sha: aa3e1ad9e675
verified-score: 9
verified-at: "2026-11-11T16:09:37.791Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: 535a16309c8a
automation-plan-sha: aa3e1ad9e675
automation-score: 10
automation-verified-at: "2026-11-11T16:16:57.133Z"
---
# Test plan: BUG-20 v2 PUT with a body id different from the route id returns 500

Scope: `PUT /api/catalog/items/{id}?api-version=2.0` on Catalog.API with the `catalog-edge` scenario (14 items, ids 1-14), called as an admin. A body `id` that differs from the route id must return `400 BadRequest` "Route id and body id must match" instead of a 500 from EF changing the key of a tracked entity, and must not modify any item. A matching body id and an omitted body id (defaulted to the route id) must keep working. Cases run at the functional layer (API against real Postgres), because the 500 comes from EF Core tracking.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-20-01 | v2 PUT with body id 2 on route id 1 returns 400 with the mismatch message | sad | functional | Expected: 400 "Route id and body id must match"; Steps to Reproduce |
| TC-BUG-20-02 | Rejected mismatch PUT leaves items 1 and 2 unchanged | sad | functional | Actual: key change of the tracked entity; nothing written |
| TC-BUG-20-03 | v2 PUT with a body id equal to the route id still returns 201 and updates the item | happy | functional | Fix must not break a valid update |
| TC-BUG-20-04 | v2 PUT without a body id uses the route id | happy | functional | Decisions: body id 0 or omitted is set to the route id |

## Out of scope

- Removing the `test.fixme` marker in `e2e/teststack/catalog-admin.spec.ts` and the bugs-table row in `testing/flows/`: repository housekeeping, not runtime behavior. The spec test "v2 PUT with a body id different from the route id is 400" automates TC-BUG-20-01.
- The v1 `PUT /items` endpoint: it passes the body id as the route id, so the mismatch check never fires there (BUG-21 covers its missing-id behavior).
- Authentication on write endpoints (BUG-4), field and reference validation (BUG-13, BUG-17, BUG-19).

## Open questions

- The suggested fix offers two outcomes (400, or ignore the body id). The cases follow the 400 option stated in Expected and in Implementation Notes.
- Whether a mismatching id on a route id that does not exist returns 400 or 404 is not stated explicitly; no case covers it.
- Whether a mismatching request with an otherwise invalid body returns 400 for the mismatch or a validation problem is not stated; no case covers it.
- A negative body id is neither described as a mismatch nor as defaulted; no case covers it.
