---
story: BUG-12
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/34"
story-sha: 5af228be8d76
plan-sha: 7dc568f4d00d
verified-score: 9
verified-at: "2026-11-11T16:10:39.395Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: 92580d21db4e
automation-plan-sha: 7dc568f4d00d
automation-score: 9
automation-verified-at: "2026-11-11T16:32:31.374Z"
---
# Test plan: BUG-12 [FE - WebApp] - Catalog page ?page=0 or ?page=-1 never loads

The WebApp catalog page must treat `?page=0` and `?page=-1` as the first page instead of asking Catalog.API for a negative `pageIndex` and hanging on the loading skeleton. Cases run on the test stack with the `catalog-edge` scenario (14 products, 9 per page, 2 pages) against the WebApp at `http://localhost:18080`, plus two repository checks for the acceptance criteria on the spec file and the flow docs.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-12-01 | ?page=0 shows the first catalog page | sad | e2e | Expected; Steps 1; Acceptance Criteria 1 |
| TC-BUG-12-02 | ?page=-1 shows the first catalog page | sad | e2e | Expected; Steps 1; Acceptance Criteria 1 |
| TC-BUG-12-03 | ?page=0 pager shows 1 / 2 with Prev disabled | sad | e2e | Expected; pager uses CurrentPage |
| TC-BUG-12-04 | ?page=-1 pager shows 1 / 2 with Prev disabled | sad | e2e | Expected; pager uses CurrentPage |
| TC-BUG-12-05 | Next from ?page=0 goes to page 2 | happy | e2e | Next link uses CurrentPage |
| TC-BUG-12-06 | ?page=1 still shows the first page | happy | e2e | Boundary just inside the clamp |
| TC-BUG-12-07 | ?page=2 still shows the second page | happy | e2e | Valid pages unaffected |
| TC-BUG-12-08 | Un-fixme'd spec and the rest of catalog-browse pass | happy | e2e | Acceptance Criteria 2 |
| TC-BUG-12-09 | Bug row removed from the bugs table in testing/flows/ | happy | unit | Acceptance Criteria 3 |

## Out of scope

- `?page=abc` (non-numeric) returning the 404 page: existing behavior, already covered by `catalog-browse`, unchanged by this story.
- Catalog.API validation of negative `pageIndex` (400): covered by the BUG-11 plan.
- Combining `?page=0` with brand or type filters: the story does not state an outcome.
- The raw Catalog.API request (`pageIndex=0`) is checked only through the rendered page, not by intercepting network calls.

## Open questions

- The story does not say whether the URL should be rewritten to drop `page=0`/`-1`; the plan only asserts rendered content and pager state.
