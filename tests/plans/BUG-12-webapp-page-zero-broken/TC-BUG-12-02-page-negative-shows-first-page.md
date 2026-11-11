---
id: TC-BUG-12-02
title: ?page=-1 shows the first catalog page
type: sad
sad-path: validation
layer: e2e
covers: ["Expected: first catalog page is shown", "Steps to Reproduce 1 (?page=-1)", "Acceptance Criteria 1"]
priority: P1
---

# TC-BUG-12-02: ?page=-1 shows the first catalog page

## Why

- Second reported input; a negative value goes through the same clamp but is a separate boundary from 0 (the WebApp sent pageIndex=-2 before the fix).

## Preconditions

- Test stack running with the `catalog-edge` scenario loaded (`testing/teststack up`, `testing/teststack load catalog-edge`): 14 products named Edge 01..14, sorted by name, 9 per page, so 2 pages.
- Anonymous browser session, WebApp at `http://localhost:18080`.

## Steps

1. In the browser open `http://localhost:18080/?page=-1`.

## Expected result

- The loading skeleton disappears and the product list renders.
- `.catalog-count` has text `14 products`.
- `.catalog-product` count is 9 and the first `.catalog-product .name` is `Edge 01 Penny Boot`.
- No element with the text "An unhandled error has occurred." is visible.
