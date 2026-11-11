---
story: BUG-17
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/39"
story-sha: ce89be60cc7e
plan-sha: c83ce68bfd94
verified-score: 9
verified-at: "2026-11-11T12:22:16.183Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: ff18134e1790
automation-plan-sha: c83ce68bfd94
automation-score: 10
automation-verified-at: "2026-11-11T12:51:17.780Z"
---
# Test plan: BUG-17 Creating a catalog item without a name returns 500

Scope: `POST /api/catalog/items?api-version=2.0` on Catalog.API with the `catalog-edge` scenario, called as an admin, with a body that has no `name`. It must return a 400 validation problem instead of a 500, must not store a row, and must not change the valid-create path. Cases run at the functional layer (API against real Postgres).

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-17-01 | Create without name returns 400 validation problem | sad | functional | Expected: 400 BadRequest with a validation problem |
| TC-BUG-17-02 | Validation problem identifies the missing name field | sad | functional | Expected: validation problem; Technical Notes: field-keyed errors |
| TC-BUG-17-03 | Rejected create without name stores no item | sad | functional | Actual: NOT NULL violation on Name; nothing persisted |
| TC-BUG-17-04 | Create with a name still returns 201 | happy | functional | Fix must not break valid create |

## Out of scope

- Empty name and negative price (BUG-13), duplicate id (BUG-18), unknown brand or type (BUG-19).
- Authentication on write endpoints (BUG-4).
- Update endpoints (the story wires validation to create only).
- Removing the `test.fixme` marker and the `testing/flows/` bugs-table row: repository housekeeping, not runtime behavior; the spec test "a body without a name is rejected with 400" is the automation for TC-BUG-17-01.

## Open questions

- The story does not say which field key the validation problem uses (`name` vs `Name`); TC-BUG-17-02 accepts the key by case-insensitive match on "name".
- Behavior for an explicit `"name": null` is not stated; it is not given a separate case.
