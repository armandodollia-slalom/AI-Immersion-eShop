---
id: TC-BUG-12-06
title: ?page=1 still shows the first page
type: happy
layer: e2e
covers: ["Boundary just inside the clamp (Page = 1)"]
priority: P2
---

# TC-BUG-12-06: ?page=1 still shows the first page

## Why

- Boundary just above the clamped values; guards against an off-by-one in Math.Max(1, ...) that would shift page 1.

## Preconditions

- Test stack running with the `catalog-edge` scenario loaded (`testing/teststack up`, `testing/teststack load catalog-edge`): 14 products named Edge 01..14, sorted by name, 9 per page, so 2 pages.
- Anonymous browser session, WebApp at `http://localhost:18080`.

## Steps

1. Open `http://localhost:18080/?page=1`.

## Expected result

- The loading skeleton disappears and the product list renders.
- `.catalog-count` has text `14 products`.
- `.catalog-product` count is 9 and the first `.catalog-product .name` is `Edge 01 Penny Boot`.
- No element with the text "An unhandled error has occurred." is visible.
- `.page-status` has text `1 / 2`.
