---
story: BUG-18
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/40"
story-sha: 98840a996041
plan-sha: cae165459703
verified-score: 9
verified-at: "2026-11-11T15:40:45.653Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: e68bda8d773d
automation-plan-sha: cae165459703
automation-score: 10
automation-verified-at: "2026-11-11T15:57:50.498Z"
---
# Test plan: BUG-18 Creating a catalog item with an existing id returns 500

Scope: `POST /api/catalog/items?api-version=2.0` on Catalog.API with the `catalog-edge` scenario (14 items, ids 1-14), called as an admin. A body whose `id` already exists must return `409 Conflict` instead of a 500 primary key violation, must leave the existing item and the item count unchanged, and must not break creation without an id. Cases run at the functional layer (API against real Postgres).

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-18-01 | Create with an existing id returns 409 | sad | functional | Expected: 409 Conflict; Steps to Reproduce |
| TC-BUG-18-02 | Rejected duplicate create leaves the existing item and the count unchanged | sad | functional | Actual: primary key violation; nothing overwritten or added |
| TC-BUG-18-03 | Create without an id still returns 201 with a generated id | happy | functional | Fix must not break valid create |
| TC-BUG-18-04 | Create with id 0 is not treated as a duplicate | sad | functional | Boundary of the existing-id check (Decisions: id 0 or below is generated) |

## Out of scope

- Authentication on write endpoints (BUG-4), missing name (BUG-17), empty name and negative price (BUG-13), unknown brand or type (BUG-19).
- Removing the `test.fixme` marker and the `testing/flows/` bugs-table row: repository housekeeping, not runtime behavior; the spec test "creating an item with an existing id is rejected with 409" is the automation for TC-BUG-18-01.
- The v1 create endpoint: the story reproduces only on `api-version=2.0`.

## Open questions

- The story offers two outcomes ("409 Conflict, or the id is ignored and a new one is generated"). The cases follow the 409 option chosen in Implementation Notes.
- The 409 body is not specified in the story (Implementation Notes mention a ProblemDetails detail "Item with id {id} already exists."); no case asserts the body.
- Behavior for a positive id that does not exist yet (for example 9999) is not stated; no case covers it.
- Whether a request that is both invalid and duplicate returns 400 or 409 is not stated; no case covers it.
- Concurrent creates with the same id are not described; no case covers them.
