---
story: BUG-6
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/48"
story-sha: d7243050e116
plan-sha: e4096210d296
verified-score: 9
verified-at: "2026-11-11T11:29:45.513Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: cb8224a54cac
automation-plan-sha: e4096210d296
automation-score: 10
automation-verified-at: "2026-11-11T11:39:00.245Z"
---
# Test plan: BUG-6 Basket.API accepts access tokens issued without the basket scope

Basket.API must reject access tokens that were not issued for the `basket` audience/scope, and must keep accepting tokens that were. All cases run against the test stack with the `basket-edge` scenario loaded, through gRPC on `http://localhost:18083` (slot-dependent, see `e2e/teststack/ports.ts`), with tokens from `getTokens()` in `e2e/teststack/auth-basket-helpers.ts`.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-6-01 | Token without the basket scope cannot update the basket | sad | functional | Expected: UNAUTHENTICATED, nothing written to Redis |
| TC-BUG-6-02 | Token with the basket scope still updates the basket | happy | functional | Regression: rest of basket-api.spec.ts still passes |
| TC-BUG-6-03 | Access token for the basket scope carries the basket audience | happy | functional | Technical Notes: ApiResource scopes give tokens an aud claim |

## Out of scope

- Removing the `test.fixme` marker and the bugs-table row in `testing/flows/identity-basket.md` (repository edits, not behavior).
- Ordering.API and Webhooks.API rejecting tokens without their scope (mentioned only as a side benefit, no expected outcome given).
- Catalog.API (unaffected per the story).

## Open questions

- Expected status for a token without the scope is "`UNAUTHENTICATED` (or `PERMISSION_DENIED`)"; the case asserts `UNAUTHENTICATED`, matching the existing spec.
- The story names only `UpdateBasket`; whether `GetBasket` and `DeleteBasket` must also reject such tokens is not stated explicitly.
- Ordering.API and Webhooks.API behavior for tokens lacking their scope is not specified with acceptance criteria.
