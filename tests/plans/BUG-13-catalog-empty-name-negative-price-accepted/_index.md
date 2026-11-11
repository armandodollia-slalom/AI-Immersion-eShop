---
story: BUG-13
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/35"
story-sha: 83f13cd094a9
plan-sha: 2f89deafbce0
verified-score: 9
verified-at: "2026-11-11T14:34:16.825Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: 4b1bf27f6529
automation-plan-sha: 2f89deafbce0
automation-score: 9
automation-verified-at: "2026-11-11T16:52:36.904Z"
---
# Test plan: BUG-13 Catalog accepts items with an empty name or a negative price

Scope: Catalog.API write endpoints (POST create, v2 PUT `/items/{id}`, v1 PUT `/items`) with the `catalog-edge` scenario as an admin. An empty name or negative price must return a 400 validation problem and change nothing; valid creates still succeed. All cases are functional (API against real Postgres).

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-13-01 | Create with an empty name returns 400 | sad | functional | Expected 400 for empty name |
| TC-BUG-13-02 | Create with a negative price returns 400 | sad | functional | Expected 400 for negative price |
| TC-BUG-13-03 | Rejected create stores no item | sad | functional | Actual: bad items stored |
| TC-BUG-13-04 | v2 PUT with an empty name returns 400 and leaves the item unchanged | sad | functional | UpdateItem validation |
| TC-BUG-13-05 | v2 PUT with a negative price returns 400 and leaves the item unchanged | sad | functional | UpdateItem validation |
| TC-BUG-13-06 | v1 PUT /items with an empty name returns 400 | sad | functional | v1 update validation |
| TC-BUG-13-07 | Valid create still returns 201 | happy | functional | No regression |
| TC-BUG-13-08 | Create with price 0 returns 201 | happy | functional | Price >= 0 boundary |
| TC-BUG-13-09 | Create with price -0.01 returns 400 | sad | functional | Price >= 0 boundary |
| TC-BUG-13-10 | Create with a whitespace-only name returns 400 | sad | functional | Whitespace name rejected |
| TC-BUG-13-11 | v1 PUT /items with a negative price returns 400 | sad | functional | v1 update validation |
| TC-BUG-13-12 | Valid v2 PUT still succeeds and persists | happy | functional | No update regression |
| TC-BUG-13-13 | v2 PUT with price 0 succeeds | happy | functional | Price >= 0 on update |
| TC-BUG-13-14 | Valid v1 PUT /items still succeeds and persists | happy | functional | No v1 update regression |

## Out of scope

- Missing `name` property (BUG-17), duplicate id, unknown brand/type, authentication on writes (BUG-4).
- Removing `test.fixme` and the `testing/flows/` bugs-table row: housekeeping, not runtime behavior; the spec test is the automation for cases 01 and 02.

## Open questions

- `ProductPriceChangedIntegrationEvent` not being published on rejected updates is not observable via the API; not asserted.
- Error key casing (`name` vs `Name`) is unspecified, so cases do not assert it.
- Behavior on update of a nonexistent id with an invalid body is unspecified.
