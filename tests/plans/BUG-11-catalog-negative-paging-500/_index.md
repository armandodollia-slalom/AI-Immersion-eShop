---
story: BUG-11
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/33"
story-sha: 40088a7ffd2c
plan-sha: 2a5b08f24aa6
verified-score: 9
verified-at: "2026-11-11T15:42:09.563Z"
verified-by: qe-plan@c3934e11/456099fb
---
# Test plan: BUG-11 [BE - Catalog.API] - Negative pageSize or pageIndex returns 500

Catalog.API must answer a negative `pageSize` or `pageIndex` (and a `pageSize` above 100) with `400` and a validation problem instead of a `500` from Postgres. The valid range is `pageSize` 0..100 and `pageIndex` >= 0; a page past the end stays `200` with an empty page. Cases run on the test stack with the `catalog-pictures` scenario loaded, against Catalog.API (`http://localhost:18082`) and the mobile BFF (`http://localhost:18087`).

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-11-01 | GET v2 items with pageSize=-1 is 400 validation problem | sad | functional | Steps to Reproduce 1; Expected: 400 BadRequest with a validation problem |
| TC-BUG-11-02 | GET v2 items with pageIndex=-1 is 400 validation problem | sad | functional | Steps to Reproduce 2; Expected: 400 BadRequest with a validation problem |
| TC-BUG-11-03 | GET v1 items with pageSize=-1 is 400 validation problem | sad | functional | Acceptance Criteria: test.fixme test, pageSize half; Expected: 400 |
| TC-BUG-11-04 | GET v1 items with pageIndex=-1 is 400 validation problem | sad | functional | Acceptance Criteria: test.fixme test, pageIndex half; Expected: 400 |
| TC-BUG-11-05 | Mobile BFF route with pageSize=-1 is 400 validation problem | sad | functional | Steps to Reproduce: mobile BFF behaves the same |
| TC-BUG-11-06 | Mobile BFF route with pageIndex=-1 is 400 validation problem | sad | functional | Steps to Reproduce: mobile BFF behaves the same |
| TC-BUG-11-07 | pageSize=101 is rejected with 400 | sad | functional | Implementation Notes: pageSize 0..100; Suggested fix: PageSize upper bound 100 |
| TC-BUG-11-08 | pageSize=100 is accepted | happy | functional | Implementation Notes: pageSize 0..100 |
| TC-BUG-11-09 | pageSize=0 stays accepted and returns an empty page | happy | functional | Implementation Notes: pageSize lower bound is 0, not 1 |
| TC-BUG-11-10 | pageIndex=0 is accepted and returns the first page | happy | functional | Suggested fix: PageIndex >= 0; Implementation Notes: pageIndex >= 0 |
| TC-BUG-11-11 | Page index past the end still returns 200 with an empty page | happy | functional | Implementation Notes: a page past the end still returns 200 with an empty page |
| TC-BUG-11-12 | Negative pageSize and pageIndex together are rejected with 400 | sad | functional | Steps to Reproduce 1 and 2 combined; Expected: 400 BadRequest with a validation problem |
| TC-BUG-11-13 | GET items by name with negative paging is 400 | sad | functional | Implementation Notes: applied to GetItemsByName; Technical Notes: pass values straight to Skip/Take |
| TC-BUG-11-14 | GET items by type and brand with negative paging is 400 | sad | functional | Implementation Notes: applied to GetItemsByTypeAndBrand |
| TC-BUG-11-15 | GET items by brand with negative paging is 400 | sad | functional | Implementation Notes: applied to GetItemsByBrand |
| TC-BUG-11-16 | catalog-api.spec passes with the fixme marker removed | happy | e2e | Acceptance Criteria: test.fixme removed, test passes and file still passes |
| TC-BUG-11-17 | Bug row removed from the bugs table in testing/flows/catalog.md | happy | unit | Acceptance Criteria: matching row removed from bugs table in testing/flows/ |
| TC-BUG-11-18 | GET relevant items v1 with negative paging is 400 | sad | functional | Implementation Notes: applied to GetRelevantItems |
| TC-BUG-11-19 | GET relevant items v2 with negative paging is 400 | sad | functional | Implementation Notes: applied to GetRelevantItems-V2 |

## Out of scope

- Basket, ordering and WebApp page-zero behavior (BUG-12).
- Non-numeric paging values (`abc`, `1.5`), already covered by the existing `catalog-api.spec.ts`.

## Open questions

- The story names the `catalog-pictures` scenario while `e2e/teststack/catalog-api.spec.ts` documents a fixed 17-item catalog; cases therefore avoid exact item counts except through `count`.
- The story does not state the validation problem's error keys or message wording, so no case asserts them.
