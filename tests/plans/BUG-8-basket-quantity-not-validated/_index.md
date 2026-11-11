---
story: BUG-8
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/50"
story-sha: 88171683a1a8
plan-sha: 7c567f232896
verified-score: 9
verified-at: "2026-11-11T15:43:00.590Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: 8666465d634d
automation-plan-sha: 7c567f232896
automation-score: 10
automation-verified-at: "2026-11-11T16:02:56.576Z"
---
# Test plan: BUG-8 Basket.API stores zero and negative quantities

`BasketApi.UpdateBasket` must reject any line with quantity < 1 with `INVALID_ARGUMENT` before anything is written to Redis, report all invalid lines in one message, and still accept valid and empty updates. All cases run at the functional layer (gRPC against real Basket.API and Redis) on the `basket-edge` scenario. TC-01 is the existing spec test in `e2e/teststack/basket-api.spec.ts`; the "rest of the file still passes" criterion is met by running that file.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-8-01 | Zero and negative quantities rejected, nothing stored | sad | functional | Expected: INVALID_ARGUMENT; Redis unchanged |
| TC-BUG-8-02 | Message lists every invalid line | sad | functional | All invalid lines in one message |
| TC-BUG-8-03 | Quantity 0 rejected | sad | functional | Quantity < 1 boundary |
| TC-BUG-8-04 | Quantity -1 rejected | sad | functional | Quantity < 1 negative |
| TC-BUG-8-05 | Quantity 1 accepted | happy | functional | Quantity = 1 boundary |
| TC-BUG-8-06 | Mixed valid/invalid lines leave basket unchanged | sad | functional | Validate before save |
| TC-BUG-8-07 | Empty update still accepted | happy | functional | Empty baskets stay valid |

## Out of scope

- Removing the `test.fixme` marker and the bug row in `testing/flows/`: repository edits, not runtime behavior.
- Authentication, other RPCs and UI behavior (unchanged by this bug).

## Open questions

- Concurrency and Redis outages during UpdateBasket are not defined by the story; no cases written.
