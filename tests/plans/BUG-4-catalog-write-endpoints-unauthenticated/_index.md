---
story: BUG-4
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/46"
story-sha: 2601a49049da
plan-sha: b6018a5e0a08
verified-score: 9
verified-at: "2026-11-11T10:47:24.600Z"
verified-by: qe-plan@09234f3a/456099fb
automation-sha: aac6adf17865
automation-plan-sha: b6018a5e0a08
automation-score: 10
automation-verified-at: "2026-11-11T17:03:13.741Z"
---
# Test plan: BUG-4 Catalog create, update and delete endpoints need no authentication

Anonymous callers must get 401 on Catalog.API create, update (v1 and v2) and delete; non-admin users get 403; only a user in role `Admin` may change the catalog; reads stay anonymous. All cases run on the test stack with the `catalog-edge` scenario loaded (catalog API at `http://localhost:18082`), which must contain an `Admin` role and an `admin` user (password `Pass123$`) in addition to the seeded alice and bob.

| ID | Title | Type | Layer | Covers |
| ---- | ------- | ------ | ------- | -------- |
| TC-BUG-4-01 | Anonymous POST create item is 401 | sad | functional | Expected: 401; step 1 |
| TC-BUG-4-02 | Anonymous PUT v2 update item is 401 | sad | functional | Expected: 401; step 2 |
| TC-BUG-4-03 | Anonymous PUT v1 update item is 401 | sad | functional | Technical Notes: UpdateItemV1 |
| TC-BUG-4-04 | Anonymous DELETE item is 401 | sad | functional | Expected: 401; step 2 |
| TC-BUG-4-05 | Rejected anonymous writes leave the catalog unchanged | sad | functional | Actual: price change publishes event |
| TC-BUG-4-06 | Invalid bearer token on write is 401 | sad | functional | Expected: 401 |
| TC-BUG-4-07 | Authenticated non-admin user gets 403 on write | sad | functional | Only an admin role can change the catalog |
| TC-BUG-4-08 | Admin can create an item | happy | functional | Only an admin role can change the catalog |
| TC-BUG-4-09 | Admin can update an item and the change persists | happy | functional | Only an admin role can change the catalog |
| TC-BUG-4-10 | Admin can delete an item | happy | functional | Only an admin role can change the catalog |
| TC-BUG-4-11 | Catalog reads stay anonymous | happy | functional | Suggested fix: reads stay anonymous |
| TC-BUG-4-12 | catalog-admin spec passes with the anonymous test enabled | happy | e2e | Acceptance Criteria: test.fixme removed |
| TC-BUG-4-13 | Admin can update an item through the v1 route | happy | functional | Technical Notes: UpdateItemV1 |
| TC-BUG-4-14 | Bug row is removed from the bugs table in testing/flows | happy | unit | Acceptance Criteria: flows row removed |

## Out of scope

- Identity.API scope/resource configuration internals (verified through the token-based cases above).
- Unit/AppHost resource model tests.

## Open questions

- Admin PUT status: the bug report lists `201` for PUT today; the plan expects the unchanged success status (201) for admin.
- Whether `ProductPriceChangedIntegrationEvent` is observable on the test stack; TC-BUG-4-05 checks only persisted state.
- Exact 401/403 response bodies are not specified; only status codes are asserted.
