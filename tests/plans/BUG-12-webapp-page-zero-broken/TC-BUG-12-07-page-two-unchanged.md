---
id: TC-BUG-12-07
title: ?page=2 still shows the second page
type: happy
layer: e2e
covers: ["Boundary: valid pages unaffected by the clamp"]
priority: P2
---

# TC-BUG-12-07: ?page=2 still shows the second page

## Why

- Regression guard: the clamp must not alter valid pages; page 2 must still request pageIndex 1.

## Preconditions

- Test stack running with the `catalog-edge` scenario loaded (`testing/teststack up`, `testing/teststack load catalog-edge`): 14 products named Edge 01..14, sorted by name, 9 per page, so 2 pages.
- Anonymous browser session, WebApp at `http://localhost:18080`.

## Steps

1. Open `http://localhost:18080/?page=2`.

## Expected result

- `.catalog-product` count is 5 and the first name is `Edge 10 Bivy`, the last `Edge 14 Last Item`.
- `.catalog-count` has text `14 products`.
- `.page-status` has text `2 / 2`.
- No "An unhandled error has occurred." element is visible.
