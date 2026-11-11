---
id: TC-BUG-12-05
title: Next from ?page=0 goes to page 2
type: happy
layer: e2e
covers: ["Code map: Next link uses CurrentPage", "Expected: first catalog page is shown"]
priority: P2
---

# TC-BUG-12-05: Next from ?page=0 goes to page 2

## Why

- Next is built from current + 1; if the clamp were missing it would point at page 1 (0 + 1) and the user would be stuck. Verifies navigation continues from the clamped page.

## Preconditions

- Test stack running with the `catalog-edge` scenario loaded (`testing/teststack up`, `testing/teststack load catalog-edge`): 14 products named Edge 01..14, sorted by name, 9 per page, so 2 pages.
- Anonymous browser session, WebApp at `http://localhost:18080`.

## Steps

1. Open `http://localhost:18080/?page=0`.
2. Click the link with name `Next page` in the `Catalog pages` navigation.

## Expected result

- The URL matches `/?page=2` (ends with `?page=2`).
- `.catalog-product` count is 5 and the names are `Edge 10 Bivy`, `Edge 11 Hiking Boot`, `Edge 12 Mega Pack`, the long-name item, `Edge 14 Last Item`.
- `.page-status` has text `2 / 2`.
