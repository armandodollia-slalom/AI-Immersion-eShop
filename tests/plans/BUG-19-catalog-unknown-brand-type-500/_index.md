---
story: BUG-19
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/41"
story-sha: 71e7cce0a568
plan-sha: 2a948dfeaa2d
verified-score: 9
verified-at: "2026-11-11T14:46:31.750Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: ffe117160864
automation-plan-sha: 2a948dfeaa2d
automation-score: 9
automation-verified-at: "2026-11-11T14:54:39.149Z"
---
# Test plan: BUG-19 Unknown brand or type ids on create or update return 500

Scope: `POST /api/catalog/items` (v2), `PUT /api/catalog/items/{id}` (v2) and `PUT /api/catalog/items` (v1) on Catalog.API with the `catalog-edge` scenario, called as an admin. Unknown `catalogBrandId` or `catalogTypeId` must return a 400 validation problem naming the id instead of a 500, store nothing, and leave valid requests unchanged. All cases run at the functional layer (API against real Postgres).

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-19-01 | Create with an unknown brand id returns 400 naming the id | sad | functional | Steps to Reproduce 1; Expected |
| TC-BUG-19-02 | Create with an unknown type id returns 400 naming the id | sad | functional | Expected; message text |
| TC-BUG-19-03 | Create with unknown brand and type reports both errors in one 400 | sad | functional | Errors collected together |
| TC-BUG-19-04 | Create with empty name and unknown brand reports both fields | sad | functional | Collected with name and price errors |
| TC-BUG-19-05 | Rejected create with unknown ids stores no item | sad | functional | Check before saving |
| TC-BUG-19-06 | v2 PUT with an unknown type id returns 400 and leaves the item unchanged | sad | functional | Steps to Reproduce 2 |
| TC-BUG-19-07 | v2 PUT with an unknown brand id returns 400 | sad | functional | Expected (update) |
| TC-BUG-19-08 | v1 PUT with an unknown brand id returns 400 | sad | functional | Implementation Notes: v1 PUT |
| TC-BUG-19-09 | Create with existing brand and type, including unused ones, still returns 201 | happy | functional | Valid ids not rejected |
| TC-BUG-19-10 | v2 PUT with existing brand and type still succeeds | happy | functional | Valid ids not rejected (update) |
| TC-BUG-19-11 | v1 PUT with an unknown type id returns 400 naming the id | sad | functional | v1 PUT; type message |
| TC-BUG-19-12 | v2 PUT to a nonexistent item with an unknown brand returns 400, not 404 | sad | functional | Check runs before item lookup |
| TC-BUG-19-13 | catalog-admin spec passes with fixme removed and flows bug row gone | happy | e2e | Acceptance criteria 2 and 3 |

## Out of scope

- Name and price validation (BUG-13), missing name (BUG-17), duplicate id (BUG-18), authentication (BUG-4).

## Open questions

- The story does not state the error key casing (`CatalogBrandId` vs `catalogBrandId`); cases match it case-insensitively.
- Negative, zero or non-integer brand/type ids are not mentioned and have no case.
- v2 PUT success status is not stated by the story; TC-BUG-19-10 asserts only 2xx.
